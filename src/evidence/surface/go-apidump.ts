/**
 * The Go exported-API extractor, as source.
 *
 * Drift shells out to a Go program rather than reimplementing Go's build
 * constraints and declaration syntax in TypeScript: `go/build` already knows
 * which files compile for a GOOS/GOARCH pair, and `go/parser` already knows
 * what a generic constraint looks like. Getting either subtly wrong would
 * produce a confident, incorrect API diff — the one failure mode Drift cannot
 * afford.
 *
 * It is a string rather than a checked-in `.go` file because Drift ships as a
 * bundled Node artefact: an adjacent file would have to survive `tsc`, esbuild,
 * and the VS Code extension packager, and would be absent in whichever one was
 * forgotten. Written out to a scratch module at run time, it is present by
 * construction.
 *
 * Standard library only. The scratch module has no requirements, so extraction
 * needs no network beyond the module being analysed, and Drift's own evidence
 * pipeline cannot be broken by someone else's dependency.
 */
export const GO_APIDUMP_SOURCE = `// Drift's Go exported-API extractor.
//
// Reads one module version out of the Go module cache and prints its exported
// API as JSON. Standard library only, on purpose: this runs inside a scratch
// module with no requirements, so it needs no network beyond the module being
// analysed and cannot be broken by a dependency of its own.
//
// Build tags are honoured per platform. go/build selects the files that
// actually compile for a GOOS/GOARCH pair, so a symbol that only exists on
// Windows is recorded as existing on Windows rather than being invented or
// lost.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type symbol struct {
	Key             string
	Name            string
	Pkg             string
	PkgName         string
	Kind            string
	Signatures      []string
	Members         []string
	RequiredMembers []string
	Platforms       []string
}

type failure struct {
	Pkg   string
	Error string
}

type dump struct {
	Module    string
	Packages  []string
	Symbols   []symbol
	Failures  []failure
	Platforms []string
}

type collector struct {
	symbols  map[string]*symbol
	packages map[string]bool
	failures []failure
}

func main() {
	dir := flag.String("dir", "", "module source directory")
	module := flag.String("module", "", "module import path")
	platforms := flag.String("platforms", "linux/amd64", "comma-separated GOOS/GOARCH pairs")
	flag.Parse()

	if *dir == "" || *module == "" {
		fmt.Fprintln(os.Stderr, "drift-apidump: -dir and -module are required")
		os.Exit(2)
	}

	c := &collector{symbols: map[string]*symbol{}, packages: map[string]bool{}}

	var used []string
	for _, raw := range strings.Split(*platforms, ",") {
		plat := strings.TrimSpace(raw)
		goos, goarch, ok := strings.Cut(plat, "/")
		if !ok || goos == "" || goarch == "" {
			continue
		}
		ctxt := build.Default
		ctxt.GOOS = goos
		ctxt.GOARCH = goarch
		ctxt.CgoEnabled = false
		ctxt.UseAllFiles = false
		used = append(used, plat)
		c.scan(&ctxt, plat, *dir, *module)
	}

	out := dump{Module: *module, Platforms: used, Failures: c.failures}
	for path := range c.packages {
		out.Packages = append(out.Packages, path)
	}
	sort.Strings(out.Packages)
	for _, s := range c.symbols {
		s.Signatures = sorted(s.Signatures)
		s.Members = sorted(s.Members)
		s.RequiredMembers = sorted(s.RequiredMembers)
		s.Platforms = sorted(s.Platforms)
		out.Symbols = append(out.Symbols, *s)
	}
	sort.Slice(out.Symbols, func(i, j int) bool { return out.Symbols[i].Key < out.Symbols[j].Key })
	if out.Failures == nil {
		out.Failures = []failure{}
	}
	if out.Symbols == nil {
		out.Symbols = []symbol{}
	}
	if out.Packages == nil {
		out.Packages = []string{}
	}

	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "drift-apidump:", err)
		os.Exit(1)
	}
}

// scan walks every directory of the module that compiles into an importable
// package for this platform.
//
// A directory that fails to parse is recorded and skipped. One unparseable
// package must not cost a developer the diff of the other four hundred.
func (c *collector) scan(ctxt *build.Context, plat, root, module string) {
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}

		base := filepath.Base(path)
		if path != root {
			// internal is unreachable from outside the module, so nothing in
			// it can break a consumer; the rest are not packages at all.
			if base == "testdata" || base == "vendor" || base == "internal" ||
				strings.HasPrefix(base, ".") || strings.HasPrefix(base, "_") {
				return filepath.SkipDir
			}
		}

		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		importPath := module
		if rel != "." {
			importPath = module + "/" + filepath.ToSlash(rel)
		}

		// A directory with no files buildable for this platform is an ordinary
		// outcome, not an error: that is exactly what a platform-specific
		// package looks like from the wrong platform.
		pkg, impErr := ctxt.ImportDir(path, 0)
		if impErr != nil || len(pkg.GoFiles) == 0 {
			return nil
		}
		if pkg.Name == "main" || strings.HasSuffix(pkg.Name, "_test") {
			return nil
		}

		c.packages[importPath] = true

		fset := token.NewFileSet()
		for _, name := range pkg.GoFiles {
			file, parseErr := parser.ParseFile(fset, filepath.Join(path, name), nil, parser.SkipObjectResolution)
			if parseErr != nil {
				c.failures = append(c.failures, failure{Pkg: importPath, Error: parseErr.Error()})
				continue
			}
			c.collect(fset, file, importPath, pkg.Name, plat)
		}
		return nil
	})
}

func (c *collector) entry(key, name, pkg, pkgName, kind, plat string) *symbol {
	s := c.symbols[key]
	if s == nil {
		s = &symbol{Key: key, Name: name, Pkg: pkg, PkgName: pkgName, Kind: kind}
		c.symbols[key] = s
	}
	// The first platform to declare a symbol names its kind. A later platform
	// disagreeing is vanishingly rare and not worth a second opinion.
	s.Platforms = addUnique(s.Platforms, plat)
	return s
}

func (c *collector) collect(fset *token.FileSet, file *ast.File, importPath, pkgName, plat string) {
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			c.collectFunc(fset, d, importPath, pkgName, plat)
		case *ast.GenDecl:
			// A ConstSpec that writes neither a type nor a value inherits both
			// from the most recent spec that did — the mechanism iota blocks
			// rely on. Tracking that inheritance here is what lets
			//   const ( A Foo = iota; B; C )
			// and the fully spelled-out
			//   const ( A Foo = iota; B Foo = iota; C Foo = iota )
			// render identical signatures: they declare the same API. Without
			// it, B and C read as bare untyped declarations and a harmless
			// rewrite between the two styles looks like a signature change.
			var inheritedType ast.Expr
			var inheritedValues []ast.Expr
			for i, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					c.collectType(fset, s, importPath, pkgName, plat)
				case *ast.ValueSpec:
					if d.Tok == token.CONST {
						if s.Type != nil {
							inheritedType = s.Type
						}
						if len(s.Values) > 0 {
							inheritedValues = s.Values
						}
						c.collectValue(fset, d.Tok.String(), s, importPath, pkgName, plat, inheritedType, inheritedValues, i)
					} else {
						c.collectValue(fset, d.Tok.String(), s, importPath, pkgName, plat, nil, nil, i)
					}
				}
			}
		}
	}
}

func (c *collector) collectFunc(fset *token.FileSet, d *ast.FuncDecl, importPath, pkgName, plat string) {
	if d.Name == nil || !ast.IsExported(d.Name.Name) {
		return
	}

	// The body is not API. Dropping it is also what keeps a signature diff from
	// firing on every internal refactor upstream.
	d.Body = nil
	signature := render(fset, d)

	if d.Recv == nil || len(d.Recv.List) == 0 {
		s := c.entry(importPath+"."+d.Name.Name, d.Name.Name, importPath, pkgName, "function", plat)
		s.Signatures = addUnique(s.Signatures, signature)
		return
	}

	owner := receiverName(d.Recv.List[0].Type)
	if owner == "" || !ast.IsExported(owner) {
		return
	}

	// Recorded twice on purpose: as a member of its type, so a removed method
	// reads as a member removal rather than an unrelated missing export, and as
	// a symbol of its own, so a changed parameter or return type is visible.
	holder := c.entry(importPath+"."+owner, owner, importPath, pkgName, "type", plat)
	holder.Members = addUnique(holder.Members, d.Name.Name)

	method := c.entry(importPath+"."+owner+"."+d.Name.Name, owner+"."+d.Name.Name, importPath, pkgName, "function", plat)
	method.Signatures = addUnique(method.Signatures, signature)
}

func (c *collector) collectType(fset *token.FileSet, spec *ast.TypeSpec, importPath, pkgName, plat string) {
	if spec.Name == nil || !ast.IsExported(spec.Name.Name) {
		return
	}
	name := spec.Name.Name
	kind := "type"
	switch spec.Type.(type) {
	case *ast.StructType:
		kind = "class"
	case *ast.InterfaceType:
		kind = "interface"
	}

	s := c.entry(importPath+"."+name, name, importPath, pkgName, kind, plat)
	if s.Kind == "type" && kind != "type" {
		s.Kind = kind
	}

	// The declaration head carries the type parameters, so a changed generic
	// constraint shows up as a signature change on the type itself.
	head := "type " + name + render(fset, spec.TypeParams)
	s.Signatures = addUnique(s.Signatures, strings.TrimSpace(head+" "+shape(fset, spec.Type)))

	switch t := spec.Type.(type) {
	case *ast.StructType:
		c.collectFields(fset, t.Fields, importPath, pkgName, plat, name, s, false)
	case *ast.InterfaceType:
		c.collectFields(fset, t.Methods, importPath, pkgName, plat, name, s, true)
	}
}

// collectFields records struct fields and interface methods as members of their
// type, and each one as a symbol of its own so a changed field or method type
// is reported at the member rather than as an opaque change to the whole type.
//
// Every method of an interface is required by construction: adding one breaks
// every implementor, which is why interface members are recorded as required.
func (c *collector) collectFields(
	fset *token.FileSet,
	fields *ast.FieldList,
	importPath, pkgName, plat, owner string,
	holder *symbol,
	isInterface bool,
) {
	if fields == nil {
		return
	}
	for _, field := range fields.List {
		if len(field.Names) == 0 {
			// An embedded field or interface. Its name is its type, and it
			// contributes the embedded API to this one.
			embedded := receiverName(field.Type)
			if embedded == "" || !ast.IsExported(embedded) {
				continue
			}
			holder.Members = addUnique(holder.Members, embedded)
			if isInterface {
				holder.RequiredMembers = addUnique(holder.RequiredMembers, embedded)
			}
			continue
		}
		for _, ident := range field.Names {
			if !ast.IsExported(ident.Name) {
				continue
			}
			holder.Members = addUnique(holder.Members, ident.Name)
			if isInterface {
				holder.RequiredMembers = addUnique(holder.RequiredMembers, ident.Name)
			}

			member := c.entry(
				importPath+"."+owner+"."+ident.Name,
				owner+"."+ident.Name,
				importPath, pkgName,
				map[bool]string{true: "function", false: "variable"}[isInterface],
				plat,
			)
			member.Signatures = addUnique(member.Signatures, strings.TrimSpace(ident.Name+" "+render(fset, field.Type)))
		}
	}
}

func (c *collector) collectValue(
	fset *token.FileSet,
	keyword string,
	spec *ast.ValueSpec,
	importPath, pkgName, plat string,
	inheritedType ast.Expr,
	inheritedValues []ast.Expr,
	iotaPos int,
) {
	declType := spec.Type
	if declType == nil {
		declType = inheritedType
	}
	values := spec.Values
	if len(values) == 0 {
		values = inheritedValues
	}

	for i, ident := range spec.Names {
		if !ast.IsExported(ident.Name) {
			continue
		}
		s := c.entry(importPath+"."+ident.Name, ident.Name, importPath, pkgName, "variable", plat)

		parts := []string{keyword, ident.Name}
		if declType != nil {
			// var X86 struct { ... } is a common shape for feature flags, and
			// printing the body whole made every added flag read as a change to
			// the variable's type. The fields are recorded as members instead,
			// where an addition is an addition and a removal is a removal.
			parts = append(parts, shape(fset, declType))
			// Field collection is keyed to the spec that actually wrote the
			// type, not one that inherited it — a struct-typed const group
			// does not exist in Go, but nothing enforces that here.
			if spec.Type != nil {
				if str, ok := declType.(*ast.StructType); ok {
					c.collectFields(fset, str.Fields, importPath, pkgName, plat, ident.Name, s, false)
				}
			}
		}
		// A constant's value is part of its contract in a way a variable's
		// initialiser is not, so only constants carry theirs into the signature.
		if keyword == "const" && i < len(values) {
			parts = append(parts, "=", renderConstValue(fset, values[i], iotaPos))
		}
		s.Signatures = addUnique(s.Signatures, strings.Join(parts, " "))
	}
}

// renderConstValue prints a constant's value expression, substituting the
// bare identifier iota with the numeric position of this ConstSpec within
// its group.
//
// iota's printed text is identical at every position in a block — it is the
// same expression node, textually, whether spelled out or inherited — so
// leaving it as iota would make an actual reordering (which changes every
// affected constant's real value) invisible to the diff. Substituting the
// position makes a real reordering produce a real text change while a purely
// stylistic rewrite between explicit and implicit repetition — same position,
// same expression — still renders identically.
func renderConstValue(fset *token.FileSet, expr ast.Expr, iotaPos int) string {
	return replaceIdentifier(render(fset, expr), "iota", fmt.Sprintf("%d", iotaPos))
}

// replaceIdentifier substitutes a bare identifier, never a substring that
// merely contains it — a package could plausibly declare its own iotaFoo.
//
// Not implemented with the regexp package's word-boundary escape: this file
// is written out as a Go source string from inside a JS template literal,
// where a backslash escape is interpreted twice — once by the JS template
// literal and once by the Go string it produces — and getting that
// double-escaping right is a trap for the next edit, not just this one.
func replaceIdentifier(text, name, value string) string {
	var out strings.Builder
	for {
		idx := strings.Index(text, name)
		if idx < 0 {
			out.WriteString(text)
			return out.String()
		}
		before := byte(0)
		if idx > 0 {
			before = text[idx-1]
		}
		after := byte(0)
		if idx+len(name) < len(text) {
			after = text[idx+len(name)]
		}
		out.WriteString(text[:idx])
		if isIdentByte(before) || isIdentByte(after) {
			out.WriteString(name)
		} else {
			out.WriteString(value)
		}
		text = text[idx+len(name):]
	}
}

func isIdentByte(b byte) bool {
	return b == '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// shape renders a type declaration's right-hand side.
//
// Struct and interface bodies are deliberately reduced to a keyword: their
// contents are already recorded member by member, and printing them whole would
// turn one added field into a change to every symbol that mentions the type.
func shape(fset *token.FileSet, expr ast.Expr) string {
	switch expr.(type) {
	case *ast.StructType:
		return "struct"
	case *ast.InterfaceType:
		return "interface"
	default:
		return render(fset, expr)
	}
}

func render(fset *token.FileSet, node any) string {
	if node == nil {
		return ""
	}
	// A typed nil (an absent *ast.FieldList, say) reaches here as a non-nil
	// any, and the printer would report an error on it.
	if list, ok := node.(*ast.FieldList); ok && list == nil {
		return ""
	}
	var buf bytes.Buffer
	if err := printer.Fprint(&buf, fset, node); err != nil {
		return ""
	}
	return collapse(buf.String())
}

func collapse(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// receiverName reduces *Foo, Foo[T], or *Foo[T] to Foo.
func receiverName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return receiverName(t.X)
	case *ast.IndexExpr:
		return receiverName(t.X)
	case *ast.IndexListExpr:
		return receiverName(t.X)
	case *ast.SelectorExpr:
		if t.Sel != nil {
			return t.Sel.Name
		}
	}
	return ""
}

// sorted normalises a collected set for output. An empty slice rather than a
// nil one, so the consumer never has to distinguish [] from null.
func sorted(list []string) []string {
	if list == nil {
		return []string{}
	}
	sort.Strings(list)
	return list
}

func addUnique(list []string, value string) []string {
	if value == "" {
		return list
	}
	for _, existing := range list {
		if existing == value {
			return list
		}
	}
	return append(list, value)
}
`;
