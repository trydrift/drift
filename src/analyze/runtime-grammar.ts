import type { RuntimeName } from '../types.js';

/** The range grammar Drift intentionally models for one runtime ecosystem. */
export interface RuntimeRangeGrammar {
  runtime: RuntimeName;
  acceptedOperators: readonly string[];
  parserKind: 'semver' | 'pep440' | 'rubygems' | 'cargo' | 'simple';
  normalizeOperator(operator: string): string | null;
}

const COMPARISON_OPERATORS = ['', '<', '<=', '>', '>=', '=', '=='] as const;

function equalityAs(operator: string, canonical: '=' | '=='): string | null {
  if (operator === '=' || operator === '==') return canonical;
  return operator;
}

/**
 * The single source of truth for upstream runtime prose grammar.
 *
 * This table describes ecosystem syntax Drift actually interprets, not every
 * token a permissive third-party parser happens to accept. In particular,
 * RubyGems has no npm caret or bare-tilde operator; its pessimistic operator
 * is `~>`, whose semantics Drift does not model yet, so all three remain
 * structured-but-unknown runtime evidence.
 */
export const RUNTIME_RANGE_GRAMMARS: Readonly<Record<RuntimeName, RuntimeRangeGrammar>> = {
  node: {
    runtime: 'node',
    acceptedOperators: [...COMPARISON_OPERATORS, '^', '~'],
    parserKind: 'semver',
    normalizeOperator: (operator) => equalityAs(operator, '='),
  },
  python: {
    runtime: 'python',
    acceptedOperators: [...COMPARISON_OPERATORS, '~='],
    parserKind: 'pep440',
    normalizeOperator: (operator) => equalityAs(operator, '=='),
  },
  ruby: {
    runtime: 'ruby',
    acceptedOperators: COMPARISON_OPERATORS,
    parserKind: 'rubygems',
    normalizeOperator: (operator) => equalityAs(operator, '='),
  },
  go: {
    runtime: 'go',
    acceptedOperators: COMPARISON_OPERATORS,
    parserKind: 'simple',
    normalizeOperator: (operator) => equalityAs(operator, '='),
  },
  java: {
    runtime: 'java',
    acceptedOperators: COMPARISON_OPERATORS,
    parserKind: 'simple',
    normalizeOperator: (operator) => equalityAs(operator, '='),
  },
  rust: {
    runtime: 'rust',
    acceptedOperators: [...COMPARISON_OPERATORS, '^', '~'],
    parserKind: 'cargo',
    normalizeOperator: (operator) => equalityAs(operator, '='),
  },
};

export interface NormalizedRuntimeOperator {
  status: 'parsed' | 'unknown';
  operator: string;
}

/** Normalize an operator only when the named ecosystem defines it. */
export function normalizeRuntimeOperator(runtime: RuntimeName, operator: string): NormalizedRuntimeOperator {
  const grammar = RUNTIME_RANGE_GRAMMARS[runtime];
  if (!grammar.acceptedOperators.includes(operator)) return { status: 'unknown', operator };
  const normalized = grammar.normalizeOperator(operator);
  return normalized === null ? { status: 'unknown', operator } : { status: 'parsed', operator: normalized };
}
