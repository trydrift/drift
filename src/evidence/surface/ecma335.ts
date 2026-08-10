/**
 * The public API of a .NET assembly, read from its own metadata.
 *
 * A `.dll` is not opaque. Every .NET assembly carries a complete, versioned
 * description of every type and member it declares — ECMA-335's metadata
 * tables — in a documented binary format, sitting inside a PE file inside a
 * zip. Reading it is the same class of act as reading a `.d.ts`: it is the
 * artefact that shipped, not a reconstruction of it, which is why this
 * provider is weighted 1.0 alongside the TypeScript one.
 *
 * The alternative was a decompiler. `ildasm` is Windows-only, `monodis` is
 * unmaintained, and both would have made .NET the one ecosystem where Drift
 * needs a tool it cannot reasonably ask a Linux CI runner to install. The
 * format is stable — it has not changed incompatibly since 2003 — so parsing
 * it directly trades a few hundred lines for a capability that works
 * everywhere and executes nothing.
 *
 * What is read: public and protected types, methods, fields, properties, and
 * events, with decoded signatures. What is not: method bodies, attributes, and
 * anything `internal`, none of which a consumer can call.
 */

export interface AssemblyType {
  /** Namespace-qualified, with nested types joined by `+` as .NET spells them. */
  fullName: string;
  kind: 'class' | 'interface' | 'enum' | 'struct' | 'delegate';
  /** `public` or `protected` members only. */
  members: string[];
  /** Members with their decoded signatures, for signature-level diffing. */
  signatures: string[];
}

/* ---------------- PE ---------------- */

interface Section {
  virtualAddress: number;
  virtualSize: number;
  rawAddress: number;
}

/**
 * Locate the CLI metadata root inside a PE file.
 *
 * Returns `null` for a native DLL — which is an ordinary thing to find in a
 * NuGet package, since many wrap a native library beside the managed one.
 */
function findMetadata(data: Buffer): { offset: number; sections: Section[] } | null {
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'

  const peOffset = data.readUInt32LE(0x3c);
  if (peOffset + 24 > data.length || data.readUInt32LE(peOffset) !== 0x00004550) return null; // 'PE\0\0'

  const sectionCount = data.readUInt16LE(peOffset + 6);
  const optionalSize = data.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  if (optionalSize === 0) return null;

  const magic = data.readUInt16LE(optionalOffset);
  // PE32 keeps four extra fields before the data directories that PE32+ drops.
  const directoriesOffset = optionalOffset + (magic === 0x20b ? 112 : 96);

  const sections: Section[] = [];
  const sectionTable = optionalOffset + optionalSize;
  for (let i = 0; i < sectionCount; i++) {
    const entry = sectionTable + i * 40;
    if (entry + 40 > data.length) break;
    sections.push({
      virtualSize: data.readUInt32LE(entry + 8),
      virtualAddress: data.readUInt32LE(entry + 12),
      rawAddress: data.readUInt32LE(entry + 20),
    });
  }

  // Data directory 14 is the CLI header.
  const cliRva = data.readUInt32LE(directoriesOffset + 14 * 8);
  if (cliRva === 0) return null;

  const cliOffset = toFileOffset(cliRva, sections);
  if (cliOffset === null || cliOffset + 16 > data.length) return null;

  // The CLI header's second data directory is the metadata itself.
  const metadataRva = data.readUInt32LE(cliOffset + 8);
  const metadataOffset = toFileOffset(metadataRva, sections);
  if (metadataOffset === null) return null;

  return { offset: metadataOffset, sections };
}

function toFileOffset(rva: number, sections: readonly Section[]): number | null {
  for (const section of sections) {
    if (rva >= section.virtualAddress && rva < section.virtualAddress + Math.max(section.virtualSize, 1)) {
      return section.rawAddress + (rva - section.virtualAddress);
    }
  }
  return null;
}

/* ---------------- metadata streams ---------------- */

interface Streams {
  tables: Buffer;
  strings: Buffer;
  blobs: Buffer;
}

function readStreams(data: Buffer, root: number): Streams | null {
  if (root + 20 > data.length || data.readUInt32LE(root) !== 0x424a5342) return null; // 'BSJB'

  const versionLength = data.readUInt32LE(root + 12);
  let cursor = root + 16 + versionLength + 2; // + flags
  const streamCount = data.readUInt16LE(cursor);
  cursor += 2;

  const found = new Map<string, Buffer>();
  for (let i = 0; i < streamCount; i++) {
    const offset = data.readUInt32LE(cursor);
    const size = data.readUInt32LE(cursor + 4);
    cursor += 8;

    let end = cursor;
    while (end < data.length && data[end] !== 0) end++;
    const name = data.toString('ascii', cursor, end);
    // Stream names are padded to a 4-byte boundary, counting the terminator.
    cursor += Math.ceil((name.length + 1) / 4) * 4;

    found.set(name, data.subarray(root + offset, root + offset + size));
  }

  // `#-` is the uncompressed table stream an edit-and-continue build emits.
  const tables = found.get('#~') ?? found.get('#-');
  const strings = found.get('#Strings');
  if (!tables || !strings) return null;

  return { tables, strings, blobs: found.get('#Blob') ?? Buffer.alloc(0) };
}

/* ---------------- tables ---------------- */

type Column =
  | { type: 'u16' }
  | { type: 'u32' }
  | { type: 'string' }
  | { type: 'guid' }
  | { type: 'blob' }
  | { type: 'rid'; table: number }
  | { type: 'coded'; family: keyof typeof CODED };

const u16: Column = { type: 'u16' };
const u32: Column = { type: 'u32' };
const str: Column = { type: 'string' };
const guid: Column = { type: 'guid' };
const blob: Column = { type: 'blob' };
const rid = (table: number): Column => ({ type: 'rid', table });
const coded = (family: keyof typeof CODED): Column => ({ type: 'coded', family });

export const TABLE = {
  Module: 0x00,
  TypeRef: 0x01,
  TypeDef: 0x02,
  Field: 0x04,
  MethodDef: 0x06,
  Param: 0x08,
  InterfaceImpl: 0x09,
  MemberRef: 0x0a,
  Constant: 0x0b,
  CustomAttribute: 0x0c,
  FieldMarshal: 0x0d,
  DeclSecurity: 0x0e,
  ClassLayout: 0x0f,
  FieldLayout: 0x10,
  StandAloneSig: 0x11,
  EventMap: 0x12,
  Event: 0x14,
  PropertyMap: 0x15,
  Property: 0x17,
  MethodSemantics: 0x18,
  MethodImpl: 0x19,
  ModuleRef: 0x1a,
  TypeSpec: 0x1b,
  ImplMap: 0x1c,
  FieldRVA: 0x1d,
  Assembly: 0x20,
  AssemblyRef: 0x23,
  File: 0x26,
  ExportedType: 0x27,
  ManifestResource: 0x28,
  NestedClass: 0x29,
  GenericParam: 0x2a,
  MethodSpec: 0x2b,
  GenericParamConstraint: 0x2c,
} as const;

/**
 * Coded-index families: which tables a tagged index can point into.
 *
 * The order is load-bearing — the tag is an index into this array — and comes
 * straight from ECMA-335 II.24.2.6. `null` marks a reserved tag value.
 */
const CODED = {
  TypeDefOrRef: [TABLE.TypeDef, TABLE.TypeRef, TABLE.TypeSpec],
  HasConstant: [TABLE.Field, TABLE.Param, TABLE.Property],
  HasCustomAttribute: [
    TABLE.MethodDef, TABLE.Field, TABLE.TypeRef, TABLE.TypeDef, TABLE.Param,
    TABLE.InterfaceImpl, TABLE.MemberRef, TABLE.Module, TABLE.DeclSecurity,
    TABLE.Property, TABLE.Event, TABLE.StandAloneSig, TABLE.ModuleRef,
    TABLE.TypeSpec, TABLE.Assembly, TABLE.AssemblyRef, TABLE.File,
    TABLE.ExportedType, TABLE.ManifestResource, TABLE.GenericParam,
    TABLE.GenericParamConstraint, TABLE.MethodSpec,
  ],
  HasFieldMarshal: [TABLE.Field, TABLE.Param],
  HasDeclSecurity: [TABLE.TypeDef, TABLE.MethodDef, TABLE.Assembly],
  MemberRefParent: [TABLE.TypeDef, TABLE.TypeRef, TABLE.ModuleRef, TABLE.MethodDef, TABLE.TypeSpec],
  HasSemantics: [TABLE.Event, TABLE.Property],
  MethodDefOrRef: [TABLE.MethodDef, TABLE.MemberRef],
  MemberForwarded: [TABLE.Field, TABLE.MethodDef],
  Implementation: [TABLE.File, TABLE.AssemblyRef, TABLE.ExportedType],
  CustomAttributeType: [null, null, TABLE.MethodDef, TABLE.MemberRef, null],
  ResolutionScope: [TABLE.Module, TABLE.ModuleRef, TABLE.AssemblyRef, TABLE.TypeRef],
  TypeOrMethodDef: [TABLE.TypeDef, TABLE.MethodDef],
} as const satisfies Record<string, readonly (number | null)[]>;

/** Every table's column layout, by table id. ECMA-335 II.22. */
const SCHEMA: Record<number, Column[]> = {
  0x00: [u16, str, guid, guid, guid],
  0x01: [coded('ResolutionScope'), str, str],
  0x02: [u32, str, str, coded('TypeDefOrRef'), rid(TABLE.Field), rid(TABLE.MethodDef)],
  0x03: [rid(TABLE.Field)],
  0x04: [u16, str, blob],
  0x05: [rid(TABLE.MethodDef)],
  0x06: [u32, u16, u16, str, blob, rid(TABLE.Param)],
  0x07: [rid(TABLE.Param)],
  0x08: [u16, u16, str],
  0x09: [rid(TABLE.TypeDef), coded('TypeDefOrRef')],
  0x0a: [coded('MemberRefParent'), str, blob],
  0x0b: [u16, coded('HasConstant'), blob],
  0x0c: [coded('HasCustomAttribute'), coded('CustomAttributeType'), blob],
  0x0d: [coded('HasFieldMarshal'), blob],
  0x0e: [u16, coded('HasDeclSecurity'), blob],
  0x0f: [u16, u32, rid(TABLE.TypeDef)],
  0x10: [u32, rid(TABLE.Field)],
  0x11: [blob],
  0x12: [rid(TABLE.TypeDef), rid(TABLE.Event)],
  0x13: [rid(TABLE.Event)],
  0x14: [u16, str, coded('TypeDefOrRef')],
  0x15: [rid(TABLE.TypeDef), rid(TABLE.Property)],
  0x16: [rid(TABLE.Property)],
  0x17: [u16, str, blob],
  0x18: [u16, rid(TABLE.MethodDef), coded('HasSemantics')],
  0x19: [rid(TABLE.TypeDef), coded('MethodDefOrRef'), coded('MethodDefOrRef')],
  0x1a: [str],
  0x1b: [blob],
  0x1c: [u16, coded('MemberForwarded'), str, rid(TABLE.ModuleRef)],
  0x1d: [u32, rid(TABLE.Field)],
  0x1e: [u32, u32],
  0x1f: [u32],
  0x20: [u32, u16, u16, u16, u16, u32, blob, str, str],
  0x21: [u32],
  0x22: [u32, u32, u32],
  0x23: [u16, u16, u16, u16, u32, blob, str, str, blob],
  0x24: [u32, rid(TABLE.AssemblyRef)],
  0x25: [u32, u32, u32, rid(TABLE.AssemblyRef)],
  0x26: [u32, str, blob],
  0x27: [u32, u32, str, str, coded('Implementation')],
  0x28: [u32, u32, str, coded('Implementation')],
  0x29: [rid(TABLE.TypeDef), rid(TABLE.TypeDef)],
  0x2a: [u16, u16, coded('TypeOrMethodDef'), str],
  0x2b: [coded('MethodDefOrRef'), blob],
  0x2c: [rid(TABLE.GenericParam), coded('TypeDefOrRef')],
};

/** A parsed metadata heap: every table as an array of numeric column values. */
class Metadata {
  readonly rows = new Map<number, number[][]>();

  constructor(
    private readonly strings: Buffer,
    readonly blobs: Buffer,
    tables: Buffer,
  ) {
    const heapSizes = tables.readUInt8(6);
    const valid = tables.readBigUInt64LE(8);

    const counts = new Map<number, number>();
    let cursor = 24;
    for (let table = 0; table < 64; table++) {
      if ((valid >> BigInt(table)) & 1n) {
        counts.set(table, tables.readUInt32LE(cursor));
        cursor += 4;
      }
    }

    const widths = {
      string: heapSizes & 0x01 ? 4 : 2,
      guid: heapSizes & 0x02 ? 4 : 2,
      blob: heapSizes & 0x04 ? 4 : 2,
    };

    const columnWidth = (column: Column): number => {
      switch (column.type) {
        case 'u16':
          return 2;
        case 'u32':
          return 4;
        case 'string':
          return widths.string;
        case 'guid':
          return widths.guid;
        case 'blob':
          return widths.blob;
        case 'rid':
          return (counts.get(column.table) ?? 0) < 0x10000 ? 2 : 4;
        case 'coded': {
          const family = CODED[column.family] as readonly (number | null)[];
          const tagBits = Math.ceil(Math.log2(family.length));
          const max = Math.max(
            ...family.map((table) => (table === null ? 0 : (counts.get(table) ?? 0))),
          );
          return max < 1 << (16 - tagBits) ? 2 : 4;
        }
      }
    };

    for (const [table, count] of counts) {
      const columns = SCHEMA[table];
      if (!columns) {
        // An unknown table cannot be skipped — its width is unknown, so every
        // table after it would be read at the wrong offset. Stop instead of
        // returning confidently wrong rows.
        break;
      }

      const sizes = columns.map(columnWidth);
      const rowSize = sizes.reduce((total, size) => total + size, 0);
      const parsed: number[][] = [];

      for (let row = 0; row < count; row++) {
        if (cursor + rowSize > tables.length) break;
        const values: number[] = [];
        let offset = cursor;
        for (const size of sizes) {
          values.push(size === 2 ? tables.readUInt16LE(offset) : tables.readUInt32LE(offset));
          offset += size;
        }
        parsed.push(values);
        cursor += rowSize;
      }

      this.rows.set(table, parsed);
    }
  }

  table(id: number): number[][] {
    return this.rows.get(id) ?? [];
  }

  string(index: number): string {
    if (index >= this.strings.length) return '';
    let end = index;
    while (end < this.strings.length && this.strings[end] !== 0) end++;
    return this.strings.toString('utf8', index, end);
  }

  /** The blob at `index`, minus its compressed length prefix. */
  blob(index: number): Buffer {
    if (index >= this.blobs.length) return Buffer.alloc(0);
    const { value, width } = uncompress(this.blobs, index);
    return this.blobs.subarray(index + width, index + width + value);
  }
}

/** ECMA-335's compressed unsigned integer: 1, 2, or 4 bytes, big-endian. */
function uncompress(data: Buffer, offset: number): { value: number; width: number } {
  const first = data[offset] ?? 0;
  if ((first & 0x80) === 0) return { value: first, width: 1 };
  if ((first & 0x40) === 0) {
    return { value: ((first & 0x3f) << 8) | (data[offset + 1] ?? 0), width: 2 };
  }
  return {
    value:
      ((first & 0x1f) << 24) |
      ((data[offset + 1] ?? 0) << 16) |
      ((data[offset + 2] ?? 0) << 8) |
      (data[offset + 3] ?? 0),
    width: 4,
  };
}

/* ---------------- visibility ---------------- */

const TYPE_VISIBILITY_MASK = 0x00000007;
const PUBLIC_TYPE = 0x00000001;
const NESTED_PUBLIC = 0x00000002;
const NESTED_FAMILY = 0x00000004;
const NESTED_FAMORASSEM = 0x00000007;
const INTERFACE_FLAG = 0x00000020;

const MEMBER_ACCESS_MASK = 0x0007;
const MEMBER_FAMILY = 0x0004;
const MEMBER_PUBLIC = 0x0006;
const MEMBER_FAMORASSEM = 0x0005;

function typeIsVisible(flags: number): boolean {
  const visibility = flags & TYPE_VISIBILITY_MASK;
  return (
    visibility === PUBLIC_TYPE ||
    visibility === NESTED_PUBLIC ||
    visibility === NESTED_FAMILY ||
    visibility === NESTED_FAMORASSEM
  );
}

/** Public, protected, or protected-internal — everything a consumer can reach. */
function memberIsVisible(flags: number): boolean {
  const access = flags & MEMBER_ACCESS_MASK;
  return access === MEMBER_PUBLIC || access === MEMBER_FAMILY || access === MEMBER_FAMORASSEM;
}

/* ---------------- the reader ---------------- */

/**
 * Read every publicly reachable type in an assembly.
 *
 * Returns `null` when the file is not a managed assembly, which is a normal
 * outcome rather than an error: NuGet packages routinely carry native binaries
 * beside the managed ones.
 */
export function readAssembly(data: Buffer): AssemblyType[] | null {
  const located = findMetadata(data);
  if (!located) return null;

  const streams = readStreams(data, located.offset);
  if (!streams) return null;

  const metadata = new Metadata(streams.strings, streams.blobs, streams.tables);
  const typeDefs = metadata.table(TABLE.TypeDef);
  if (typeDefs.length === 0) return null;

  const fields = metadata.table(TABLE.Field);
  const methods = metadata.table(TABLE.MethodDef);
  const properties = metadata.table(TABLE.Property);
  const events = metadata.table(TABLE.Event);

  const enclosing = new Map<number, number>();
  for (const [nested, parent] of metadata.table(TABLE.NestedClass)) {
    if (nested !== undefined && parent !== undefined) enclosing.set(nested, parent);
  }

  // Property and event ownership is recorded on a map table rather than on the
  // type, so it is inverted once here rather than searched per type.
  const propertyOwner = rangesToOwners(metadata.table(TABLE.PropertyMap), properties.length);
  const eventOwner = rangesToOwners(metadata.table(TABLE.EventMap), events.length);

  const out: AssemblyType[] = [];

  for (let i = 0; i < typeDefs.length; i++) {
    const row = typeDefs[i]!;
    const flags = row[0]!;
    if (!typeIsVisible(flags)) continue;

    const name = metadata.string(row[1]!);
    // The compiler-emitted root of every module, and the closure and iterator
    // classes the C# compiler generates. None is API.
    if (name === '<Module>' || name.startsWith('<')) continue;

    const fullName = qualify(metadata, typeDefs, enclosing, i);
    const baseName = typeRefName(metadata, row[3]!);

    const members: string[] = [];
    const signatures: string[] = [];

    for (const index of range(row[4]!, i, typeDefs, 4, fields.length)) {
      const field = fields[index]!;
      if (!memberIsVisible(field[0]!)) continue;
      const fieldName = metadata.string(field[1]!);
      if (fieldName.startsWith('<')) continue;
      members.push(fieldName);
      signatures.push(`${fieldName}: ${decodeFieldSignature(metadata, metadata.blob(field[2]!))}`);
    }

    for (const index of range(row[5]!, i, typeDefs, 5, methods.length)) {
      const method = methods[index]!;
      if (!memberIsVisible(method[2]!)) continue;
      const methodName = metadata.string(method[3]!);
      // Property and event accessors are reported through the property, which
      // is the thing a consumer actually writes.
      if (methodName.startsWith('<') || /^(get_|set_|add_|remove_)/.test(methodName)) continue;
      members.push(methodName);
      signatures.push(`${methodName}${decodeMethodSignature(metadata, metadata.blob(method[4]!))}`);
    }

    for (const index of propertyOwner.get(i + 1) ?? []) {
      const propertyName = metadata.string(properties[index]![1]!);
      if (propertyName.startsWith('<')) continue;
      members.push(propertyName);
      signatures.push(`${propertyName} { get; set; }`);
    }

    for (const index of eventOwner.get(i + 1) ?? []) {
      const eventName = metadata.string(events[index]![1]!);
      if (eventName.startsWith('<')) continue;
      members.push(eventName);
      signatures.push(`event ${eventName}`);
    }

    out.push({
      fullName,
      kind: kindOf(flags, baseName),
      members: [...new Set(members)],
      signatures: [...new Set(signatures)],
    });
  }

  return out;
}

function kindOf(flags: number, baseName: string | null): AssemblyType['kind'] {
  if (flags & INTERFACE_FLAG) return 'interface';
  if (baseName === 'System.Enum') return 'enum';
  if (baseName === 'System.ValueType') return 'struct';
  if (baseName === 'System.MulticastDelegate' || baseName === 'System.Delegate') return 'delegate';
  return 'class';
}

/**
 * A type's full name, walking out through every enclosing type.
 *
 * `Outer+Inner` is how .NET itself spells a nested type, and using the same
 * spelling means a finding names something a developer can search for.
 */
function qualify(
  metadata: Metadata,
  typeDefs: readonly number[][],
  enclosing: ReadonlyMap<number, number>,
  index: number,
): string {
  const parts: string[] = [];
  let current = index;

  for (let depth = 0; depth < 16; depth++) {
    const row = typeDefs[current];
    if (!row) break;
    parts.unshift(metadata.string(row[1]!));

    const parent = enclosing.get(current + 1);
    if (parent === undefined) {
      const namespace = metadata.string(row[2]!);
      return namespace ? `${namespace}.${parts.join('+')}` : parts.join('+');
    }
    current = parent - 1;
  }

  return parts.join('+');
}

/** The name behind a `TypeDefOrRef` coded index, for base-class checks. */
function typeRefName(metadata: Metadata, codedIndex: number): string | null {
  const tag = codedIndex & 0x03;
  const row = codedIndex >> 2;
  if (row === 0) return null;

  if (tag === 0) {
    const typeDef = metadata.table(TABLE.TypeDef)[row - 1];
    if (!typeDef) return null;
    const namespace = metadata.string(typeDef[2]!);
    const name = metadata.string(typeDef[1]!);
    return namespace ? `${namespace}.${name}` : name;
  }
  if (tag === 1) {
    const typeRef = metadata.table(TABLE.TypeRef)[row - 1];
    if (!typeRef) return null;
    const namespace = metadata.string(typeRef[2]!);
    const name = metadata.string(typeRef[1]!);
    return namespace ? `${namespace}.${name}` : name;
  }
  return null;
}

/**
 * The rows one type owns in a child table.
 *
 * The tables use a run-length convention: a type's list starts at its own
 * index and ends where the next type's begins, so the *next* row is what
 * bounds this one — and the last type runs to the end of the child table.
 */
function range(
  start: number,
  typeIndex: number,
  typeDefs: readonly number[][],
  column: number,
  total: number,
): number[] {
  const next = typeDefs[typeIndex + 1]?.[column] ?? total + 1;
  const out: number[] = [];
  for (let i = start; i < next && i <= total; i++) out.push(i - 1);
  return out;
}

/** `PropertyMap`/`EventMap` rows -> owning TypeDef rid -> child row indices. */
function rangesToOwners(map: readonly number[][], total: number): Map<number, number[]> {
  const owners = new Map<number, number[]>();

  for (let i = 0; i < map.length; i++) {
    const [parent, start] = map[i]!;
    if (parent === undefined || start === undefined) continue;
    const end = map[i + 1]?.[1] ?? total + 1;
    const indices: number[] = [];
    for (let row = start; row < end && row <= total; row++) indices.push(row - 1);
    owners.set(parent, indices);
  }

  return owners;
}

/* ---------------- signatures ---------------- */

/**
 * Decode a method signature blob into `(paramTypes) : returnType`.
 *
 * Parameter *names* are deliberately absent — they live in the `Param` table,
 * not the signature, and renaming one is not a breaking change for any caller
 * that does not use named arguments. Arity and types are what break callers,
 * and those are exactly what this keeps.
 */
export function decodeMethodSignature(metadata: Metadata, signature: Buffer): string {
  if (signature.length === 0) return '(?)';

  let offset = 0;
  const callingConvention = signature[offset++]!;

  let generics = '';
  if (callingConvention & 0x10) {
    const count = uncompress(signature, offset);
    offset += count.width;
    generics = `<${count.value}>`;
  }

  const paramCount = uncompress(signature, offset);
  offset += paramCount.width;

  const returnType = decodeType(metadata, signature, offset);
  offset = returnType.offset;

  const params: string[] = [];
  for (let i = 0; i < paramCount.value; i++) {
    if (offset >= signature.length) break;
    const param = decodeType(metadata, signature, offset);
    offset = param.offset;
    params.push(param.text);
  }

  return `${generics}(${params.join(', ')}): ${returnType.text}`;
}

export function decodeFieldSignature(metadata: Metadata, signature: Buffer): string {
  // A field signature is the FIELD calling convention (0x06) then one type.
  if (signature.length < 2) return '?';
  return decodeType(metadata, signature, 1).text;
}

const ELEMENT_TYPES: Record<number, string> = {
  0x01: 'void',
  0x02: 'bool',
  0x03: 'char',
  0x04: 'sbyte',
  0x05: 'byte',
  0x06: 'short',
  0x07: 'ushort',
  0x08: 'int',
  0x09: 'uint',
  0x0a: 'long',
  0x0b: 'ulong',
  0x0c: 'float',
  0x0d: 'double',
  0x0e: 'string',
  0x16: 'TypedReference',
  0x18: 'IntPtr',
  0x19: 'UIntPtr',
  0x1c: 'object',
};

/**
 * One type from a signature blob.
 *
 * Recursive, because the encoding is: an array of a generic instance of a
 * pointer is written exactly that way, outermost first. Depth is bounded by
 * the blob's own length, which the caller has already read.
 */
function decodeType(
  metadata: Metadata,
  signature: Buffer,
  start: number,
): { text: string; offset: number } {
  let offset = start;
  const code = signature[offset++];
  if (code === undefined) return { text: '?', offset };

  const simple = ELEMENT_TYPES[code];
  if (simple) return { text: simple, offset };

  switch (code) {
    // BYREF, PTR, PINNED, SZARRAY — a decoration on the type that follows.
    case 0x0f: {
      const inner = decodeType(metadata, signature, offset);
      return { text: `${inner.text}*`, offset: inner.offset };
    }
    case 0x10: {
      const inner = decodeType(metadata, signature, offset);
      return { text: `ref ${inner.text}`, offset: inner.offset };
    }
    case 0x1d: {
      const inner = decodeType(metadata, signature, offset);
      return { text: `${inner.text}[]`, offset: inner.offset };
    }
    case 0x45: {
      const inner = decodeType(metadata, signature, offset);
      return { text: inner.text, offset: inner.offset };
    }
    // CLASS / VALUETYPE: a TypeDefOrRef coded index.
    case 0x11:
    case 0x12: {
      const token = uncompress(signature, offset);
      offset += token.width;
      return { text: typeRefName(metadata, token.value) ?? 'object', offset };
    }
    // VAR / MVAR: a generic parameter, by position.
    case 0x13:
    case 0x1e: {
      const index = uncompress(signature, offset);
      offset += index.width;
      return { text: `${code === 0x13 ? 'T' : 'M'}${index.value}`, offset };
    }
    // GENERICINST: a generic type plus its arguments.
    case 0x15: {
      const base = decodeType(metadata, signature, offset);
      offset = base.offset;
      const count = uncompress(signature, offset);
      offset += count.width;

      const args: string[] = [];
      for (let i = 0; i < count.value; i++) {
        const arg = decodeType(metadata, signature, offset);
        offset = arg.offset;
        args.push(arg.text);
      }
      return { text: `${base.text}<${args.join(', ')}>`, offset };
    }
    // ARRAY: element type, rank, then bounds tables that carry no type info.
    case 0x14: {
      const element = decodeType(metadata, signature, offset);
      offset = element.offset;
      const rank = uncompress(signature, offset);
      offset += rank.width;

      for (const _ of ['sizes', 'lowBounds']) {
        void _;
        const count = uncompress(signature, offset);
        offset += count.width;
        for (let i = 0; i < count.value; i++) offset += uncompress(signature, offset).width;
      }
      return { text: `${element.text}[${','.repeat(Math.max(0, rank.value - 1))}]`, offset };
    }
    // CMOD_REQD / CMOD_OPT: a modifier token, then the type it modifies.
    case 0x1f:
    case 0x20: {
      const token = uncompress(signature, offset);
      offset += token.width;
      return decodeType(metadata, signature, offset);
    }
    case 0x1b:
      return { text: 'delegate', offset };
    default:
      return { text: 'object', offset };
  }
}

export type { Metadata };
