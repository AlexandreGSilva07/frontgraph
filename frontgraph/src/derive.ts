import { existsSync, statSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import ts from 'typescript'
import type { GraphNode } from './parser'

const TS_JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

export interface DerivedFacts {
  dependencies: string[]
  exports: string[]
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function stripTsExtension(p: string): string {
  return p.replace(/\.(ts|tsx|js|jsx)$/, '')
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (filePath.endsWith('.js')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * Resolve a module specifier from a TS/JS file to an internal node id, or null
 * when the specifier is external (bare package, asset, unresolvable). SPEC §6.1.
 */
export function resolveTsSpecifier(
  specifier: string,
  fromFileRel: string,
  rootDir: string,
): string | null {
  let candidate: string
  if (specifier.startsWith('@/')) {
    candidate = `src/${specifier.slice(2)}`
  } else if (specifier.startsWith('.')) {
    candidate = toPosix(normalize(join(dirname(toPosix(fromFileRel)), specifier)))
  } else {
    return null
  }
  if (candidate.startsWith('..')) return null

  // NodeNext-style './x.js' may point at x.ts — resolve from the base name.
  const base = stripTsExtension(candidate)
  for (const ext of TS_JS_EXTENSIONS) {
    if (existsSync(resolve(rootDir, base + ext))) return base
  }

  const dirPath = resolve(rootDir, candidate)
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    for (const ext of TS_JS_EXTENSIONS) {
      if (existsSync(join(dirPath, `index${ext}`))) return `${candidate}/index`
    }
  }

  return null
}

/** Derive dependencies and exports from a TS/JS file via the TypeScript AST. SPEC §6. */
export function deriveTsFacts(
  content: string,
  fileRelPath: string,
  rootDir: string,
): DerivedFacts {
  const source = ts.createSourceFile(
    fileRelPath, content, ts.ScriptTarget.Latest, true, scriptKindFor(fileRelPath),
  )

  const specifiers = new Set<string>()
  const exports_ = new Set<string>()

  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === kind)

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      specifiers.add(stmt.moduleSpecifier.text)
      continue
    }

    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        specifiers.add(stmt.moduleSpecifier.text)
      }
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) exports_.add(el.name.text)
      }
      // `export * from` is not enumerated in v1 (SPEC §6.2)
      continue
    }

    if (ts.isExportAssignment(stmt)) {
      exports_.add('default')
      continue
    }

    if (!hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) continue
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        collectBindingNames(decl.name, exports_)
      }
    } else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      const name = stmt.name?.text
      if (isDefault) exports_.add(name ? `${name} (default)` : 'default')
      else if (name) exports_.add(name)
    } else if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
    ) {
      if (ts.isIdentifier(stmt.name)) exports_.add(stmt.name.text)
    }
  }

  // Dynamic import() and require() can appear anywhere in the tree.
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const arg = node.arguments[0]
      if (ts.isStringLiteral(arg)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) specifiers.add(arg.text)
        else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          specifiers.add(arg.text)
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(source)

  const dependencies = new Set<string>()
  for (const spec of specifiers) {
    const id = resolveTsSpecifier(spec, fileRelPath, rootDir)
    if (id) dependencies.add(id)
  }

  return { dependencies: [...dependencies].sort(), exports: [...exports_] }
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text)
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) collectBindingNames(el.name, out)
    }
  }
}

// ── Drift detection (SPEC §7) ──

export type DriftKind =
  | 'undeclared-dependency'
  | 'stale-dependency'
  | 'undeclared-export'
  | 'stale-export'

export interface DriftIssue {
  nodeId: string
  filePath: string
  kind: DriftKind
  detail: string
}

export function detectDrift(nodes: GraphNode[]): DriftIssue[] {
  const ids = new Set(nodes.map(n => n.id))
  const issues: DriftIssue[] = []

  for (const node of nodes) {
    if (node.id.includes('#')) continue

    if (node.derivedDependencies) {
      const declared = new Set(node.declaredDependencies ?? [])
      const declaredBases = new Set(
        [...declared].filter(d => d.includes('#')).map(d => d.split('#')[0]),
      )
      const derived = new Set(node.derivedDependencies)

      for (const dep of derived) {
        if (!declared.has(dep) && !declaredBases.has(dep)) {
          issues.push({
            nodeId: node.id, filePath: node.filePath, kind: 'undeclared-dependency',
            detail: `code imports '${dep}' but the @graph block does not declare it`,
          })
        }
      }
      for (const dep of declared) {
        if (!ids.has(dep)) continue
        const base = dep.split('#')[0]
        if (!derived.has(dep) && !derived.has(base)) {
          issues.push({
            nodeId: node.id, filePath: node.filePath, kind: 'stale-dependency',
            detail: `block declares dependency '${dep}' but the code does not import it`,
          })
        }
      }
    }

    if (node.derivedExports) {
      const declared = new Set(node.declaredExports ?? [])
      const derived = new Set(node.derivedExports)
      for (const e of derived) {
        if (!declared.has(e)) {
          issues.push({
            nodeId: node.id, filePath: node.filePath, kind: 'undeclared-export',
            detail: `code exports '${e}' but the @graph block does not declare it`,
          })
        }
      }
      for (const e of declared) {
        if (!derived.has(e)) {
          issues.push({
            nodeId: node.id, filePath: node.filePath, kind: 'stale-export',
            detail: `block declares export '${e}' but the code does not export it`,
          })
        }
      }
    }
  }

  return issues
}
