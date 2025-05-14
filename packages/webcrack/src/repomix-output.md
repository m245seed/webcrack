This file is a merged representation of the entire codebase, combined into a single document by Repomix.
The content has been processed where comments have been removed, empty lines have been removed.

# Directory Structure
```
ast-utils/ast.ts
ast-utils/generator.ts
ast-utils/index.ts
ast-utils/inline.ts
ast-utils/matcher.ts
ast-utils/matchers.d.ts
ast-utils/rename.ts
ast-utils/scope.ts
ast-utils/transform.ts
cjs-wrapper.ts
cli-wrapper.js
cli.ts
deobfuscate/array-rotator.ts
deobfuscate/control-flow-object.ts
deobfuscate/control-flow-switch.ts
deobfuscate/dead-code.ts
deobfuscate/debug-protection.ts
deobfuscate/decoder.ts
deobfuscate/evaluate-globals.ts
deobfuscate/index.ts
deobfuscate/inline-decoded-strings.ts
deobfuscate/inline-decoder-wrappers.ts
deobfuscate/inline-object-props.ts
deobfuscate/merge-object-assignments.ts
deobfuscate/self-defending.ts
deobfuscate/string-array.ts
deobfuscate/var-functions.ts
deobfuscate/vm.ts
index.ts
plugin.ts
transforms/jsx-new.ts
transforms/jsx.ts
transforms/mangle.ts
transpile/index.ts
transpile/transforms/default-parameters.ts
transpile/transforms/index.ts
transpile/transforms/logical-assignments.ts
transpile/transforms/nullish-coalescing-assignment.ts
transpile/transforms/nullish-coalescing.ts
transpile/transforms/optional-chaining.ts
transpile/transforms/template-literals.ts
unminify/index.ts
unminify/transforms/block-statements.ts
unminify/transforms/computed-properties.ts
unminify/transforms/for-to-while.ts
unminify/transforms/index.ts
unminify/transforms/infinity.ts
unminify/transforms/invert-boolean-logic.ts
unminify/transforms/json-parse.ts
unminify/transforms/logical-to-if.ts
unminify/transforms/merge-else-if.ts
unminify/transforms/merge-strings.ts
unminify/transforms/number-expressions.ts
unminify/transforms/raw-literals.ts
unminify/transforms/remove-double-not.ts
unminify/transforms/sequence.ts
unminify/transforms/split-for-loop-vars.ts
unminify/transforms/split-variable-declarations.ts
unminify/transforms/ternary-to-if.ts
unminify/transforms/truncate-number-literal.ts
unminify/transforms/typeof-undefined.ts
unminify/transforms/unary-expressions.ts
unminify/transforms/unminify-booleans.ts
unminify/transforms/void-to-undefined.ts
unminify/transforms/yoda.ts
unpack/browserify/bundle.ts
unpack/browserify/index.ts
unpack/browserify/module.ts
unpack/bundle.ts
unpack/index.ts
unpack/module.ts
unpack/path.ts
unpack/webpack/bundle.ts
unpack/webpack/common-matchers.ts
unpack/webpack/esm.ts
unpack/webpack/getDefaultExport.ts
unpack/webpack/module.ts
unpack/webpack/unpack-webpack-4.ts
unpack/webpack/unpack-webpack-5.ts
unpack/webpack/unpack-webpack-chunk.ts
unpack/webpack/varInjection.ts
utils/platform.ts
```

# Files

## File: ast-utils/ast.ts
````typescript
import * as t from '@babel/types';
export function getPropName(node: t.Node): string | undefined {
  if (t.isIdentifier(node)) {
    return node.name;
  }
  if (t.isStringLiteral(node)) {
    return node.value;
  }
  if (t.isNumericLiteral(node)) {
    return node.value.toString();
  }
}
````

## File: ast-utils/generator.ts
````typescript
import type { GeneratorOptions } from '@babel/generator';
import babelGenerate from '@babel/generator';
import type * as t from '@babel/types';
const defaultOptions: GeneratorOptions = { jsescOption: { minimal: true } };
export function generate(
  ast: t.Node,
  options: GeneratorOptions = defaultOptions,
): string {
  return babelGenerate(ast, options).code;
}
export function codePreview(node: t.Node): string {
  const code = generate(node, {
    minified: true,
    shouldPrintComment: () => false,
    ...defaultOptions,
  });
  if (code.length > 100) {
    return code.slice(0, 70) + ' … ' + code.slice(-30);
  }
  return code;
}
````

## File: ast-utils/index.ts
````typescript
export * from './ast';
export * from './generator';
export * from './inline';
export * from './matcher';
export * from './rename';
export * from './transform';
````

## File: ast-utils/inline.ts
````typescript
import type { Binding, NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { getPropName } from '.';
import { findParent } from './matcher';
export function inlineVariable(
  binding: Binding,
  value = m.anyExpression(),
  unsafeAssignments = false,
) {
  const varDeclarator = binding.path.node;
  const varMatcher = m.variableDeclarator(
    m.identifier(binding.identifier.name),
    value,
  );
  const assignmentMatcher = m.assignmentExpression(
    '=',
    m.identifier(binding.identifier.name),
    value,
  );
  if (binding.constant && varMatcher.match(varDeclarator)) {
    binding.referencePaths.forEach((ref) => {
      ref.replaceWith(varDeclarator.init!);
    });
    binding.path.remove();
  } else if (unsafeAssignments && binding.constantViolations.length >= 1) {
    const assignments = binding.constantViolations
      .map((path) => path.node)
      .filter((node) => assignmentMatcher.match(node));
    if (!assignments.length) return;
    function getNearestAssignment(location: number) {
      return assignments.findLast((assignment) => assignment.start! < location);
    }
    for (const ref of binding.referencePaths) {
      const assignment = getNearestAssignment(ref.node.start!);
      if (assignment) ref.replaceWith(assignment.right);
    }
    for (const path of binding.constantViolations) {
      if (path.parentPath?.isExpressionStatement()) {
        path.remove();
      } else if (path.isAssignmentExpression()) {
        path.replaceWith(path.node.right);
      }
    }
    binding.path.remove();
  }
}
export function inlineArrayElements(
  array: t.ArrayExpression,
  references: NodePath[],
): void {
  for (const reference of references) {
    const memberPath = reference.parentPath! as NodePath<t.MemberExpression>;
    const property = memberPath.node.property as t.NumericLiteral;
    const index = property.value;
    const replacement = array.elements[index]!;
    memberPath.replaceWith(t.cloneNode(replacement));
  }
}
export function inlineObjectProperties(
  binding: Binding,
  property = m.objectProperty(),
): void {
  const varDeclarator = binding.path.node;
  const objectProperties = m.capture(m.arrayOf(property));
  const varMatcher = m.variableDeclarator(
    m.identifier(binding.identifier.name),
    m.objectExpression(objectProperties),
  );
  if (!varMatcher.match(varDeclarator)) return;
  const propertyMap = new Map(
    objectProperties.current!.map((p) => [getPropName(p.key), p.value]),
  );
  if (
    !binding.referencePaths.every((ref) => {
      const member = ref.parent as t.MemberExpression;
      const propName = getPropName(member.property)!;
      return propertyMap.has(propName);
    })
  )
    return;
  binding.referencePaths.forEach((ref) => {
    const memberPath = ref.parentPath as NodePath<t.MemberExpression>;
    const propName = getPropName(memberPath.node.property)!;
    const value = propertyMap.get(propName)!;
    memberPath.replaceWith(value);
  });
  binding.path.remove();
}
export function inlineFunctionCall(
  fn: t.FunctionExpression | t.FunctionDeclaration,
  caller: NodePath<t.CallExpression>,
): void {
  if (t.isRestElement(fn.params[1])) {
    caller.replaceWith(
      t.callExpression(
        caller.node.arguments[0] as t.Identifier,
        caller.node.arguments.slice(1),
      ),
    );
    return;
  }
  const returnedValue = (fn.body.body[0] as t.ReturnStatement).argument!;
  const clone = t.cloneNode(returnedValue, true);
  traverse(clone, {
    Identifier(path) {
      const paramIndex = fn.params.findIndex(
        (p) => (p as t.Identifier).name === path.node.name,
      );
      if (paramIndex !== -1) {
        path.replaceWith(
          caller.node.arguments[paramIndex] ??
            t.unaryExpression('void', t.numericLiteral(0)),
        );
        path.skip();
      }
    },
    noScope: true,
  });
  caller.replaceWith(clone);
}
export function inlineFunctionAliases(binding: Binding): { changes: number } {
  const state = { changes: 0 };
  const refs = [...binding.referencePaths];
  for (const ref of refs) {
    const fn = findParent(ref, m.functionDeclaration());
    const fnName = m.capture(m.anyString());
    const returnedCall = m.capture(
      m.callExpression(
        m.identifier(binding.identifier.name),
        m.anyList(m.slice({ min: 2 })),
      ),
    );
    const matcher = m.functionDeclaration(
      m.identifier(fnName),
      m.anyList(m.slice({ min: 2 })),
      m.blockStatement([m.returnStatement(returnedCall)]),
    );
    if (fn && matcher.match(fn.node)) {
      const paramUsedInDecodeCall = fn.node.params.some((param) => {
        const binding = fn.scope.getBinding((param as t.Identifier).name);
        return binding?.referencePaths.some((ref) =>
          ref.findParent((p) => p.node === returnedCall.current),
        );
      });
      if (!paramUsedInDecodeCall) continue;
      const fnBinding = fn.scope.parent.getBinding(fnName.current!);
      if (!fnBinding) continue;
      const fnRefs = fnBinding.referencePaths;
      refs.push(...fnRefs);
      const callRefs = fnRefs
        .filter(
          (ref) =>
            t.isCallExpression(ref.parent) &&
            t.isIdentifier(ref.parent.callee, { name: fnName.current! }),
        )
        .map((ref) => ref.parentPath!) as NodePath<t.CallExpression>[];
      for (const callRef of callRefs) {
        inlineFunctionCall(fn.node, callRef);
        state.changes++;
      }
      fn.remove();
      state.changes++;
    }
  }
  binding.scope.crawl();
  return state;
}
export function inlineVariableAliases(
  binding: Binding,
  targetName = binding.identifier.name,
): { changes: number } {
  const state = { changes: 0 };
  const refs = [...binding.referencePaths];
  const varName = m.capture(m.anyString());
  const matcher = m.or(
    m.variableDeclarator(
      m.identifier(varName),
      m.identifier(binding.identifier.name),
    ),
    m.assignmentExpression(
      '=',
      m.identifier(varName),
      m.identifier(binding.identifier.name),
    ),
  );
  for (const ref of refs) {
    if (matcher.match(ref.parent)) {
      const varScope = ref.scope;
      const varBinding = varScope.getBinding(varName.current!);
      if (!varBinding) continue;
      if (ref.isIdentifier({ name: varBinding.identifier.name })) continue;
      state.changes += inlineVariableAliases(varBinding, targetName).changes;
      if (ref.parentPath?.isAssignmentExpression()) {
        varBinding.path.remove();
        if (t.isExpressionStatement(ref.parentPath.parent)) {
          ref.parentPath.remove();
        } else {
          ref.parentPath.replaceWith(t.identifier(targetName));
        }
      } else if (ref.parentPath?.isVariableDeclarator()) {
        ref.parentPath.remove();
      }
      state.changes++;
    } else {
      ref.replaceWith(t.identifier(targetName));
      state.changes++;
    }
  }
  return state;
}
````

## File: ast-utils/matcher.ts
````typescript
import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
export const safeLiteral: m.Matcher<t.Literal> = m.matcher(
  (node) =>
    t.isLiteral(node) &&
    (!t.isTemplateLiteral(node) || node.expressions.length === 0),
);
export function infiniteLoop(
  body?: m.Matcher<t.Statement>,
): m.Matcher<t.ForStatement | t.WhileStatement> {
  return m.or(
    m.forStatement(undefined, null, undefined, body),
    m.forStatement(undefined, truthyMatcher, undefined, body),
    m.whileStatement(truthyMatcher, body),
  );
}
export function constKey(
  name?: string | m.Matcher<string>,
): m.Matcher<t.Identifier | t.StringLiteral> {
  return m.or(m.identifier(name), m.stringLiteral(name));
}
export function constObjectProperty(
  value?: m.Matcher<t.Expression>,
): m.Matcher<t.ObjectProperty> {
  return m.or(
    m.objectProperty(m.identifier(), value, false),
    m.objectProperty(m.or(m.stringLiteral(), m.numericLiteral()), value),
  );
}
export function anonymousFunction(
  params?:
    | m.Matcher<(t.Identifier | t.RestElement | t.Pattern)[]>
    | (
        | m.Matcher<t.Identifier>
        | m.Matcher<t.Pattern>
        | m.Matcher<t.RestElement>
      )[],
  body?: m.Matcher<t.BlockStatement>,
): m.Matcher<t.FunctionExpression | t.ArrowFunctionExpression> {
  return m.or(
    m.functionExpression(null, params, body, false),
    m.arrowFunctionExpression(params, body),
  );
}
export function iife(
  params?:
    | m.Matcher<(t.Identifier | t.RestElement | t.Pattern)[]>
    | (
        | m.Matcher<t.Identifier>
        | m.Matcher<t.Pattern>
        | m.Matcher<t.RestElement>
      )[],
  body?: m.Matcher<t.BlockStatement>,
): m.Matcher<t.CallExpression> {
  return m.callExpression(anonymousFunction(params, body));
}
export function constMemberExpression(
  object: string | m.Matcher<t.Expression>,
  property?: string | m.Matcher<string>,
): m.Matcher<t.MemberExpression> {
  if (typeof object === 'string') object = m.identifier(object);
  return m.or(
    m.memberExpression(object, m.identifier(property), false),
    m.memberExpression(object, m.stringLiteral(property), true),
  );
}
export const undefinedMatcher = m.or(
  m.identifier('undefined'),
  m.unaryExpression('void', m.numericLiteral(0)),
);
export const trueMatcher = m.or(
  m.booleanLiteral(true),
  m.unaryExpression('!', m.numericLiteral(0)),
  m.unaryExpression('!', m.unaryExpression('!', m.numericLiteral(1))),
  m.unaryExpression('!', m.unaryExpression('!', m.arrayExpression([]))),
);
export const falseMatcher = m.or(
  m.booleanLiteral(false),
  m.unaryExpression('!', m.arrayExpression([])),
);
export const truthyMatcher = m.or(trueMatcher, m.arrayExpression([]));
export function findParent<T extends t.Node>(
  path: NodePath,
  matcher: m.Matcher<T>,
): NodePath<T> | null {
  return path.findParent((path) =>
    matcher.match(path.node),
  ) as NodePath<T> | null;
}
export function findPath<T extends t.Node>(
  path: NodePath,
  matcher: m.Matcher<T>,
): NodePath<T> | null {
  return path.find((path) => matcher.match(path.node)) as NodePath<T> | null;
}
export function createFunctionMatcher(
  params: number,
  body: (
    ...captures: m.Matcher<t.Identifier>[]
  ) => m.Matcher<t.Statement[]> | m.Matcher<t.Statement>[],
): m.Matcher<t.FunctionExpression> {
  const captures = Array.from({ length: params }, () =>
    m.capture(m.anyString()),
  );
  return m.functionExpression(
    undefined,
    captures.map(m.identifier),
    m.blockStatement(
      body(...captures.map((c) => m.identifier(m.fromCapture(c)))),
    ),
  );
}
export function isReadonlyObject(
  binding: Binding,
  memberAccess: m.Matcher<t.MemberExpression>,
): boolean {
  if (!binding.constant && binding.constantViolations[0] !== binding.path)
    return false;
  function isPatternAssignment(member: NodePath<t.Node>) {
    const { parentPath } = member;
    return (
      parentPath?.isArrayPattern() ||
      (parentPath?.parentPath?.isObjectPattern() &&
        (parentPath.isObjectProperty({ value: member.node }) ||
          parentPath.isRestElement())) ||
      parentPath?.isAssignmentPattern({ left: member.node })
    );
  }
  return binding.referencePaths.every(
    (path) =>
      memberAccess.match(path.parent) &&
      !path.parentPath?.parentPath?.isAssignmentExpression({
        left: path.parent,
      }) &&
      !path.parentPath?.parentPath?.isUpdateExpression({
        argument: path.parent,
      }) &&
      !path.parentPath?.parentPath?.isUnaryExpression({
        argument: path.parent,
        operator: 'delete',
      }) &&
      !isPatternAssignment(path.parentPath!),
  );
}
export function isTemporaryVariable(
  binding: Binding | undefined,
  references: number,
  kind: 'var' | 'param' = 'var',
): binding is Binding {
  return (
    binding !== undefined &&
    binding.references === references &&
    binding.constantViolations.length === 1 &&
    (kind === 'var'
      ? binding.path.isVariableDeclarator() && binding.path.node.init === null
      : binding.path.listKey === 'params' && binding.path.isIdentifier())
  );
}
export class AnySubListMatcher<T> extends m.Matcher<T[]> {
  constructor(private readonly matchers: m.Matcher<T>[]) {
    super();
  }
  matchValue(array: unknown, keys: readonly PropertyKey[]): array is T[] {
    if (!Array.isArray(array)) return false;
    if (this.matchers.length === 0 && array.length === 0) return true;
    let j = 0;
    for (let i = 0; i < array.length; i++) {
      const matches = this.matchers[j].matchValue(array[i], [...keys, i]);
      if (matches) {
        j++;
        if (j === this.matchers.length) {
          return true;
        }
      }
    }
    return false;
  }
}
export function anySubList<T>(
  ...elements: Array<m.Matcher<T>>
): m.Matcher<Array<T>> {
  return new AnySubListMatcher(elements);
}
````

## File: ast-utils/matchers.d.ts
````typescript
import type { Matcher } from '@codemod/matchers';
type MatcherType<T> = T extends Matcher<infer U> ? U : T;
declare module '@codemod/matchers' {
  export function or(): Matcher<never>;
  export function or<T>(first: Matcher<T> | T): Matcher<T>;
  export function or<T, U>(
    first: Matcher<T> | T,
    second: Matcher<U> | U,
  ): Matcher<T | U>;
  export function or<T, U, V>(
    first: Matcher<T> | T,
    second: Matcher<U> | U,
    third: Matcher<V> | V,
  ): Matcher<T | U | V>;
  export function or<T, U, V, W>(
    first: Matcher<T> | T,
    second: Matcher<U> | U,
    third: Matcher<V> | V,
    fourth: Matcher<W> | W,
  ): Matcher<T | U | V | W>;
  export function or<T, U, V, W, X>(
    first: Matcher<T> | T,
    second: Matcher<U> | U,
    third: Matcher<V> | V,
    fourth: Matcher<W> | W,
    fifth: Matcher<X> | X,
  ): Matcher<T | U | V | W | X>;
  export function or<const T extends readonly unknown[]>(
    ...matchers: T
  ): Matcher<MatcherType<T[number]>>;
}
declare module '@codemod/matchers/build/matchers/predicate' {
  export function predicate<T>(predicate: (value: T) => boolean): Matcher<T>;
}
declare module '@babel/traverse' {
  interface NodePath {
    toString(): string;
  }
}
````

## File: ast-utils/rename.ts
````typescript
import type { Binding, NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { codePreview } from './generator';
export function renameFast(binding: Binding, newName: string): void {
  binding.referencePaths.forEach((ref) => {
    if (ref.isExportDefaultDeclaration()) return;
    if (!ref.isIdentifier()) {
      throw new Error(
        `Unexpected reference (${ref.type}): ${codePreview(ref.node)}`,
      );
    }
    if (ref.scope.hasBinding(newName)) ref.scope.rename(newName);
    ref.node.name = newName;
  });
  const patternMatcher = m.assignmentExpression(
    '=',
    m.or(m.arrayPattern(), m.objectPattern()),
  );
  binding.constantViolations.forEach((ref) => {
    if (ref.scope.hasBinding(newName)) ref.scope.rename(newName);
    if (ref.isAssignmentExpression() && t.isIdentifier(ref.node.left)) {
      ref.node.left.name = newName;
    } else if (ref.isUpdateExpression() && t.isIdentifier(ref.node.argument)) {
      ref.node.argument.name = newName;
    } else if (
      ref.isUnaryExpression({ operator: 'delete' }) &&
      t.isIdentifier(ref.node.argument)
    ) {
      ref.node.argument.name = newName;
    } else if (ref.isVariableDeclarator() && t.isIdentifier(ref.node.id)) {
      ref.node.id.name = newName;
    } else if (ref.isVariableDeclarator() && t.isArrayPattern(ref.node.id)) {
      const ids = ref.getBindingIdentifiers();
      for (const id in ids) {
        if (id === binding.identifier.name) {
          ids[id].name = newName;
        }
      }
    } else if (ref.isFor() || patternMatcher.match(ref.node)) {
      traverse(ref.node, {
        Identifier(path) {
          if (path.scope !== ref.scope) return path.skip();
          if (path.node.name === binding.identifier.name) {
            path.node.name = newName;
          }
        },
        noScope: true,
      });
    } else if (ref.isFunctionDeclaration() && t.isIdentifier(ref.node.id)) {
      ref.node.id.name = newName;
    } else {
      throw new Error(
        `Unexpected constant violation (${ref.type}): ${codePreview(ref.node)}`,
      );
    }
  });
  binding.scope.removeOwnBinding(binding.identifier.name);
  binding.scope.bindings[newName] = binding;
  binding.identifier.name = newName;
}
export function renameParameters(
  path: NodePath<t.Function>,
  newNames: string[],
): void {
  const params = path.node.params as t.Identifier[];
  for (let i = 0; i < Math.min(params.length, newNames.length); i++) {
    const binding = path.scope.getBinding(params[i].name)!;
    renameFast(binding, newNames[i]);
  }
}
````

## File: ast-utils/scope.ts
````typescript
import type { Scope } from '@babel/traverse';
import { toIdentifier } from '@babel/types';
export function generateUid(scope: Scope, name: string = 'temp'): string {
  let uid = '';
  let i = 1;
  do {
    uid = toIdentifier(i > 1 ? `${name}${i}` : name);
    i++;
  } while (
    scope.hasLabel(uid) ||
    scope.hasBinding(uid) ||
    scope.hasGlobal(uid) ||
    scope.hasReference(uid)
  );
  const program = scope.getProgramParent();
  program.references[uid] = true;
  program.uids[uid] = true;
  return uid;
}
````

## File: ast-utils/transform.ts
````typescript
import type { Node, TraverseOptions, Visitor } from '@babel/traverse';
import traverse, { visitors } from '@babel/traverse';
import debug from 'debug';
const logger = debug('webcrack:transforms');
export async function applyTransformAsync<TOptions>(
  ast: Node,
  transform: AsyncTransform<TOptions>,
  options?: TOptions,
): Promise<TransformState> {
  logger(`${transform.name}: started`);
  const state: TransformState = { changes: 0 };
  await transform.run?.(ast, state, options);
  if (transform.visitor)
    traverse(ast, transform.visitor(options), undefined, state);
  logger(`${transform.name}: finished with ${state.changes} changes`);
  return state;
}
export function applyTransform<TOptions>(
  ast: Node,
  transform: Transform<TOptions>,
  options?: TOptions,
): TransformState {
  logger(`${transform.name}: started`);
  const state: TransformState = { changes: 0 };
  transform.run?.(ast, state, options);
  if (transform.visitor) {
    const visitor = transform.visitor(
      options,
    ) as TraverseOptions<TransformState>;
    visitor.noScope = !transform.scope;
    traverse(ast, visitor, undefined, state);
  }
  logger(`${transform.name}: finished with ${state.changes} changes`);
  return state;
}
export function applyTransforms(
  ast: Node,
  transforms: Transform[],
  options: { noScope?: boolean; name?: string; log?: boolean } = {},
): TransformState {
  options.log ??= true;
  const name = options.name ?? transforms.map((t) => t.name).join(', ');
  if (options.log) logger(`${name}: started`);
  const state: TransformState = { changes: 0 };
  for (const transform of transforms) {
    transform.run?.(ast, state);
  }
  const traverseOptions = transforms.flatMap((t) => t.visitor?.() ?? []);
  if (traverseOptions.length > 0) {
    const visitor: TraverseOptions<TransformState> =
      visitors.merge(traverseOptions);
    visitor.noScope = options.noScope || transforms.every((t) => !t.scope);
    traverse(ast, visitor, undefined, state);
  }
  if (options.log) logger(`${name}: finished with ${state.changes} changes`);
  return state;
}
export function mergeTransforms(options: {
  name: string;
  tags: Tag[];
  transforms: Transform[];
}): Transform {
  return {
    name: options.name,
    tags: options.tags,
    scope: options.transforms.some((t) => t.scope),
    visitor() {
      return visitors.merge(
        options.transforms.flatMap((t) => t.visitor?.() ?? []),
      );
    },
  };
}
export interface TransformState {
  changes: number;
}
export interface Transform<TOptions = unknown> {
  name: string;
  tags: Tag[];
  scope?: boolean;
  run?: (ast: Node, state: TransformState, options?: TOptions) => void;
  visitor?: (options?: TOptions) => Visitor<TransformState>;
}
export interface AsyncTransform<TOptions = unknown>
  extends Omit<Transform<TOptions>, 'run'> {
  run?: (ast: Node, state: TransformState, options?: TOptions) => Promise<void>;
}
export type Tag = 'safe' | 'unsafe';
````

## File: cjs-wrapper.ts
````typescript
import type { webcrack as wc } from './index.js';
export const webcrack: typeof wc = async (...args) => {
  const { webcrack } = await import('./index.js');
  return webcrack(...args);
};
````

## File: cli-wrapper.js
````javascript
#!/usr/bin/env node
import "../dist/cli.js"
````

## File: cli.ts
````typescript
#!/usr/bin/env node
import { program } from 'commander';
import debug from 'debug';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as url from 'node:url';
import { webcrack } from './index.js';
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const { version, description } = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string; description: string };
debug.enable('webcrack:*');
interface Options {
  force: boolean;
  output?: string;
  mangle: boolean;
  jsx: boolean;
  unpack: boolean;
  deobfuscate: boolean;
  unminify: boolean;
}
async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
program
  .version(version)
  .description(description)
  .option('-o, --output <path>', 'output directory for bundled files')
  .option('-f, --force', 'overwrite output directory')
  .option('-m, --mangle', 'mangle variable names')
  .option('--no-jsx', 'do not decompile JSX')
  .option('--no-unpack', 'do not extract modules from the bundle')
  .option('--no-deobfuscate', 'do not deobfuscate the code')
  .option('--no-unminify', 'do not unminify the code')
  .argument('[file]', 'input file, defaults to stdin')
  .action(async (input: string | undefined) => {
    const { output, force, ...options } = program.opts<Options>();
    const code = await (input ? readFile(input, 'utf8') : readStdin());
    if (output) {
      if (force || !existsSync(output)) {
        await rm(output, { recursive: true, force: true });
      } else {
        program.error('output directory already exists');
      }
    }
    const result = await webcrack(code, options);
    if (output) {
      await result.save(output);
    } else {
      console.log(result.code);
      if (result.bundle) {
        debug('webcrack:unpack')(
          'Modules are not displayed in the terminal. Use the --output option to save them to a directory.',
        );
      }
    }
  })
  .parse();
````

## File: deobfuscate/array-rotator.ts
````typescript
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { callExpression } from '@codemod/matchers';
import {
  constMemberExpression,
  findParent,
  iife,
  infiniteLoop,
} from '../ast-utils';
import type { StringArray } from './string-array';
export type ArrayRotator = NodePath<t.ExpressionStatement>;
export function findArrayRotator(
  stringArray: StringArray,
): ArrayRotator | undefined {
  const arrayIdentifier = m.capture(m.identifier());
  const pushShift = m.callExpression(
    constMemberExpression(arrayIdentifier, 'push'),
    [
      m.callExpression(
        constMemberExpression(m.fromCapture(arrayIdentifier), 'shift'),
      ),
    ],
  );
  const callMatcher = iife(
    m.anything(),
    m.blockStatement(
      m.anyList(
        m.zeroOrMore(),
        infiniteLoop(
          m.matcher((node) => {
            return (
              m
                .containerOf(callExpression(m.identifier('parseInt')))
                .match(node) &&
              m
                .blockStatement([
                  m.tryStatement(
                    m.containerOf(pushShift),
                    m.containerOf(pushShift),
                  ),
                ])
                .match(node)
            );
          }),
        ),
      ),
    ),
  );
  const matcher = m.expressionStatement(
    m.or(callMatcher, m.unaryExpression('!', callMatcher)),
  );
  for (const ref of stringArray.references) {
    const rotator = findParent(ref, matcher);
    if (rotator) {
      return rotator;
    }
  }
}
````

## File: deobfuscate/control-flow-object.ts
````typescript
import type { Binding, NodePath } from '@babel/traverse';
import type { FunctionExpression } from '@babel/types';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
import {
  applyTransform,
  constKey,
  constMemberExpression,
  createFunctionMatcher,
  findParent,
  getPropName,
  inlineFunctionCall,
  isReadonlyObject,
} from '../ast-utils';
import mergeStrings from '../unminify/transforms/merge-strings';
export default {
  name: 'control-flow-object',
  tags: ['safe'],
  scope: true,
  visitor() {
    const varId = m.capture(m.identifier());
    const propertyName = m.matcher<string>((name) => /^[a-z]{5}$/i.test(name));
    const propertyKey = constKey(propertyName);
    const propertyValue = m.or(
      m.stringLiteral(),
      createFunctionMatcher(2, (left, right) => [
        m.returnStatement(
          m.or(
            m.binaryExpression(undefined, left, right),
            m.logicalExpression(undefined, left, right),
            m.binaryExpression(undefined, right, left),
            m.logicalExpression(undefined, right, left),
          ),
        ),
      ]),
      m.matcher<FunctionExpression>((node) => {
        return (
          t.isFunctionExpression(node) &&
          createFunctionMatcher(node.params.length, (...params) => [
            m.returnStatement(m.callExpression(params[0], params.slice(1))),
          ]).match(node)
        );
      }),
      (() => {
        const fnName = m.capture(m.identifier());
        const restName = m.capture(m.identifier());
        return m.functionExpression(
          undefined,
          [fnName, m.restElement(restName)],
          m.blockStatement([
            m.returnStatement(
              m.callExpression(m.fromCapture(fnName), [
                m.spreadElement(m.fromCapture(restName)),
              ]),
            ),
          ]),
        );
      })(),
    );
    const objectProperties = m.capture(
      m.arrayOf(m.objectProperty(propertyKey, propertyValue)),
    );
    const aliasId = m.capture(m.identifier());
    const aliasVar = m.variableDeclaration(m.anything(), [
      m.variableDeclarator(aliasId, m.fromCapture(varId)),
    ]);
    const assignedKey = m.capture(propertyName);
    const assignedValue = m.capture(propertyValue);
    const assignment = m.expressionStatement(
      m.assignmentExpression(
        '=',
        constMemberExpression(m.fromCapture(varId), assignedKey),
        assignedValue,
      ),
    );
    const looseAssignment = m.expressionStatement(
      m.assignmentExpression(
        '=',
        constMemberExpression(m.fromCapture(varId), assignedKey),
      ),
    );
    const memberAccess = constMemberExpression(
      m.or(m.fromCapture(varId), m.fromCapture(aliasId)),
      propertyName,
    );
    const varMatcher = m.variableDeclarator(
      varId,
      m.objectExpression(objectProperties),
    );
    const inlineMatcher = constMemberExpression(
      m.objectExpression(objectProperties),
      propertyName,
    );
    function isConstantBinding(binding: Binding) {
      return binding.constant || binding.constantViolations[0] === binding.path;
    }
    function transform(path: NodePath<t.VariableDeclarator>) {
      let changes = 0;
      if (varMatcher.match(path.node)) {
        const binding = path.scope.getBinding(varId.current!.name);
        if (!binding) return changes;
        if (!isConstantBinding(binding)) return changes;
        if (!transformObjectKeys(binding)) return changes;
        if (!isReadonlyObject(binding, memberAccess)) return changes;
        const props = new Map(
          objectProperties.current!.map((p) => [
            getPropName(p.key),
            p.value as t.FunctionExpression | t.StringLiteral,
          ]),
        );
        if (!props.size) return changes;
        const oldRefs = [...binding.referencePaths];
        [...binding.referencePaths].reverse().forEach((ref) => {
          const memberPath = ref.parentPath as NodePath<t.MemberExpression>;
          const propName = getPropName(memberPath.node.property)!;
          const value = props.get(propName);
          if (!value) {
            ref.addComment('leading', 'webcrack:control_flow_missing_prop');
            return;
          }
          if (t.isStringLiteral(value)) {
            memberPath.replaceWith(value);
          } else {
            inlineFunctionCall(
              value,
              memberPath.parentPath as NodePath<t.CallExpression>,
            );
          }
          changes++;
        });
        oldRefs.forEach((ref) => {
          const varDeclarator = findParent(ref, m.variableDeclarator());
          if (varDeclarator) changes += transform(varDeclarator);
        });
        path.remove();
        changes++;
      }
      return changes;
    }
    function transformObjectKeys(objBinding: Binding): boolean {
      const container = objBinding.path.parentPath!.container as t.Statement[];
      const startIndex = (objBinding.path.parentPath!.key as number) + 1;
      const properties: t.ObjectProperty[] = [];
      for (let i = startIndex; i < container.length; i++) {
        const statement = container[i];
        if (looseAssignment.match(statement)) {
          applyTransform(statement, mergeStrings);
        }
        if (assignment.match(statement)) {
          properties.push(
            t.objectProperty(
              t.identifier(assignedKey.current!),
              assignedValue.current!,
            ),
          );
        } else {
          break;
        }
      }
      const aliasAssignment = container[startIndex + properties.length];
      if (!aliasVar.match(aliasAssignment)) return true;
      if (objBinding.references !== properties.length + 1) return false;
      const aliasBinding = objBinding.scope.getBinding(aliasId.current!.name)!;
      if (!isReadonlyObject(aliasBinding, memberAccess)) return false;
      objectProperties.current!.push(...properties);
      container.splice(startIndex, properties.length);
      objBinding.referencePaths = aliasBinding.referencePaths;
      objBinding.references = aliasBinding.references;
      objBinding.identifier.name = aliasBinding.identifier.name;
      aliasBinding.path.remove();
      return true;
    }
    return {
      VariableDeclarator: {
        exit(path) {
          this.changes += transform(path);
        },
      },
      MemberExpression: {
        exit(path) {
          if (!inlineMatcher.match(path.node)) return;
          const propName = getPropName(path.node.property)!;
          const value = objectProperties.current!.find(
            (prop) => getPropName(prop.key) === propName,
          )?.value as t.FunctionExpression | t.StringLiteral | undefined;
          if (!value) return;
          if (t.isStringLiteral(value)) {
            path.replaceWith(value);
          } else if (path.parentPath.isCallExpression()) {
            inlineFunctionCall(value, path.parentPath);
          } else {
            path.replaceWith(value);
          }
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
````

## File: deobfuscate/control-flow-switch.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
import { constMemberExpression, infiniteLoop } from '../ast-utils';
export default {
  name: 'control-flow-switch',
  tags: ['safe'],
  visitor() {
    const sequenceName = m.capture(m.identifier());
    const sequenceString = m.capture(
      m.matcher<string>((s) => /^\d+(\|\d+)*$/.test(s)),
    );
    const iterator = m.capture(m.identifier());
    const cases = m.capture(
      m.arrayOf(
        m.switchCase(
          m.stringLiteral(m.matcher((s) => /^\d+$/.test(s))),
          m.anyList(
            m.zeroOrMore(),
            m.or(m.continueStatement(), m.returnStatement()),
          ),
        ),
      ),
    );
    const matcher = m.blockStatement(
      m.anyList<t.Statement>(
        m.variableDeclaration(undefined, [
          m.variableDeclarator(
            sequenceName,
            m.callExpression(
              constMemberExpression(m.stringLiteral(sequenceString), 'split'),
              [m.stringLiteral('|')],
            ),
          ),
        ]),
        m.variableDeclaration(undefined, [m.variableDeclarator(iterator)]),
        infiniteLoop(
          m.blockStatement([
            m.switchStatement(
              m.memberExpression(
                m.fromCapture(sequenceName),
                m.updateExpression('++', m.fromCapture(iterator)),
                true,
              ),
              cases,
            ),
            m.breakStatement(),
          ]),
        ),
        m.zeroOrMore(),
      ),
    );
    return {
      BlockStatement: {
        exit(path) {
          if (!matcher.match(path.node)) return;
          const caseStatements = new Map(
            cases.current!.map((c) => [
              (c.test as t.StringLiteral).value,
              t.isContinueStatement(c.consequent.at(-1))
                ? c.consequent.slice(0, -1)
                : c.consequent,
            ]),
          );
          const sequence = sequenceString.current!.split('|');
          const newStatements = sequence.flatMap((s) => caseStatements.get(s)!);
          path.node.body.splice(0, 3, ...newStatements);
          this.changes += newStatements.length + 3;
        },
      },
    };
  },
} satisfies Transform;
````

## File: deobfuscate/dead-code.ts
````typescript
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
import { renameFast } from '../ast-utils';
export default {
  name: 'dead-code',
  tags: ['unsafe'],
  scope: true,
  visitor() {
    const stringComparison = m.binaryExpression(
      m.or('===', '==', '!==', '!='),
      m.stringLiteral(),
      m.stringLiteral(),
    );
    const testMatcher = m.or(
      stringComparison,
      m.unaryExpression('!', stringComparison),
    );
    return {
      'IfStatement|ConditionalExpression': {
        exit(_path) {
          const path = _path as NodePath<
            t.IfStatement | t.ConditionalExpression
          >;
          if (!testMatcher.match(path.node.test)) return;
          if (path.get('test').evaluateTruthy()) {
            replace(path, path.get('consequent'));
          } else if (path.node.alternate) {
            replace(path, path.get('alternate') as NodePath);
          } else {
            path.remove();
          }
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
function replace(path: NodePath<t.Conditional>, replacement: NodePath) {
  if (t.isBlockStatement(replacement.node)) {
    const childBindings = replacement.scope.bindings;
    for (const name in childBindings) {
      const binding = childBindings[name];
      if (path.scope.hasOwnBinding(name)) {
        renameFast(binding, path.scope.generateUid(name));
      }
      binding.scope = path.scope;
      path.scope.bindings[binding.identifier.name] = binding;
    }
    path.replaceWithMultiple(replacement.node.body);
  } else {
    path.replaceWith(replacement);
  }
}
````

## File: deobfuscate/debug-protection.ts
````typescript
import * as m from '@codemod/matchers';
import { ifStatement } from '@codemod/matchers';
import type { Transform } from '../ast-utils';
import { constMemberExpression, findParent, iife } from '../ast-utils';
export default {
  name: 'debug-protection',
  tags: ['safe'],
  scope: true,
  visitor() {
    const ret = m.capture(m.identifier());
    const debugProtectionFunctionName = m.capture(m.anyString());
    const debuggerProtection = m.capture(m.identifier());
    const counter = m.capture(m.identifier());
    const debuggerTemplate = m.ifStatement(
      undefined,
      undefined,
      m.containerOf(
        m.or(
          m.debuggerStatement(),
          m.callExpression(
            constMemberExpression(m.anyExpression(), 'constructor'),
            [m.stringLiteral('debugger')],
          ),
        ),
      ),
    );
    const intervalCall = m.callExpression(
      constMemberExpression(m.anyExpression(), 'setInterval'),
      [
        m.identifier(m.fromCapture(debugProtectionFunctionName)),
        m.numericLiteral(),
      ],
    );
    const matcher = m.functionDeclaration(
      m.identifier(debugProtectionFunctionName),
      [ret],
      m.blockStatement([
        m.functionDeclaration(
          debuggerProtection,
          [counter],
          m.blockStatement([
            debuggerTemplate,
            m.expressionStatement(
              m.callExpression(m.fromCapture(debuggerProtection), [
                m.updateExpression('++', m.fromCapture(counter), true),
              ]),
            ),
          ]),
        ),
        m.tryStatement(
          m.blockStatement([
            ifStatement(
              m.fromCapture(ret),
              m.blockStatement([
                m.returnStatement(m.fromCapture(debuggerProtection)),
              ]),
              m.blockStatement([
                m.expressionStatement(
                  m.callExpression(m.fromCapture(debuggerProtection), [
                    m.numericLiteral(0),
                  ]),
                ),
              ]),
            ),
          ]),
        ),
      ]),
    );
    return {
      FunctionDeclaration(path) {
        if (!matcher.match(path.node)) return;
        const binding = path.scope.getBinding(
          debugProtectionFunctionName.current!,
        );
        binding?.referencePaths.forEach((ref) => {
          if (intervalCall.match(ref.parent)) {
            findParent(ref, iife())?.remove();
          }
        });
        path.remove();
      },
    };
  },
} satisfies Transform;
````

## File: deobfuscate/decoder.ts
````typescript
import { expression } from '@babel/template';
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import * as m from '@codemod/matchers';
import {
  anySubList,
  findParent,
  inlineVariable,
  renameFast,
} from '../ast-utils';
import type { StringArray } from './string-array';
export class Decoder {
  originalName: string;
  name: string;
  path: NodePath<t.FunctionDeclaration>;
  constructor(
    originalName: string,
    name: string,
    path: NodePath<t.FunctionDeclaration>,
  ) {
    this.originalName = originalName;
    this.name = name;
    this.path = path;
  }
  collectCalls(): NodePath<t.CallExpression>[] {
    const calls: NodePath<t.CallExpression>[] = [];
    const literalArgument: m.Matcher<t.Expression> = m.or(
      m.binaryExpression(
        m.anything(),
        m.matcher((node) => literalArgument.match(node)),
        m.matcher((node) => literalArgument.match(node)),
      ),
      m.unaryExpression(
        '-',
        m.matcher((node) => literalArgument.match(node)),
      ),
      m.numericLiteral(),
      m.stringLiteral(),
    );
    const literalCall = m.callExpression(
      m.identifier(this.name),
      m.arrayOf(literalArgument),
    );
    const expressionCall = m.callExpression(
      m.identifier(this.name),
      m.arrayOf(m.anyExpression()),
    );
    const conditional = m.capture(m.conditionalExpression());
    const conditionalCall = m.callExpression(m.identifier(this.name), [
      conditional,
    ]);
    const buildExtractedConditional = expression`TEST ? CALLEE(CONSEQUENT) : CALLEE(ALTERNATE)`;
    const binding = this.path.scope.getBinding(this.name)!;
    for (const ref of binding.referencePaths) {
      if (conditionalCall.match(ref.parent)) {
        // decode(test ? 1 : 2) -> test ? decode(1) : decode(2)
        const [replacement] = ref.parentPath!.replaceWith(
          buildExtractedConditional({
            TEST: conditional.current!.test,
            CALLEE: ref.parent.callee,
            CONSEQUENT: conditional.current!.consequent,
            ALTERNATE: conditional.current!.alternate,
          }),
        );
        // some of the scope information is somehow lost after replacing
        replacement.scope.crawl();
      } else if (literalCall.match(ref.parent)) {
        calls.push(ref.parentPath as NodePath<t.CallExpression>);
      } else if (expressionCall.match(ref.parent)) {
        // var n = 1; decode(n); -> decode(1);
        ref.parentPath!.traverse({
          ReferencedIdentifier(path) {
            const varBinding = path.scope.getBinding(path.node.name)!;
            if (!varBinding) return;
            inlineVariable(varBinding, literalArgument, true);
          },
        });
        if (literalCall.match(ref.parent)) {
          calls.push(ref.parentPath as NodePath<t.CallExpression>);
        }
      } else if (ref.parentPath?.isExpressionStatement()) {
        // `decode;` may appear on it's own in some forked obfuscators
        ref.parentPath.remove();
      }
    }
    return calls;
  }
}
export function findDecoders(stringArray: StringArray): Decoder[] {
  const decoders: Decoder[] = [];
  const functionName = m.capture(m.anyString());
  const arrayIdentifier = m.capture(m.identifier());
  const matcher = m.functionDeclaration(
    m.identifier(functionName),
    m.anything(),
    m.blockStatement(
      anySubList(
        // var array = getStringArray();
        m.variableDeclaration(undefined, [
          m.variableDeclarator(
            arrayIdentifier,
            m.callExpression(m.identifier(stringArray.name)),
          ),
        ]),
        // var h = array[e]; return h;
        // or return array[e -= 254];
        m.containerOf(
          m.memberExpression(m.fromCapture(arrayIdentifier), undefined, true),
        ),
      ),
    ),
  );
  for (const ref of stringArray.references) {
    const decoderFn = findParent(ref, matcher);
    if (decoderFn) {
      const oldName = functionName.current!;
      const newName = `__DECODE_${decoders.length}__`;
      const binding = decoderFn.scope.getBinding(oldName)!;
      renameFast(binding, newName);
      decoders.push(new Decoder(oldName, newName, decoderFn));
    }
  }
  return decoders;
}
````

## File: deobfuscate/evaluate-globals.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
const FUNCTIONS = {
  atob,
  unescape,
  decodeURI,
  decodeURIComponent,
};
export default {
  name: 'evaluate-globals',
  tags: ['safe'],
  scope: true,
  visitor() {
    const name = m.capture(
      m.or(...(Object.keys(FUNCTIONS) as (keyof typeof FUNCTIONS)[])),
    );
    const arg = m.capture(m.anyString());
    const matcher = m.callExpression(m.identifier(name), [
      m.stringLiteral(arg),
    ]);
    return {
      CallExpression: {
        exit(path) {
          if (!matcher.match(path.node)) return;
          if (path.scope.hasBinding(name.current!, { noGlobals: true })) return;
          try {
            const value = FUNCTIONS[name.current!].call(
              globalThis,
              arg.current!,
            );
            path.replaceWith(t.stringLiteral(value));
            this.changes++;
          } catch {
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: deobfuscate/index.ts
````typescript
import debug from 'debug';
import type { AsyncTransform } from '../ast-utils';
import {
  applyTransform,
  applyTransformAsync,
  applyTransforms,
} from '../ast-utils';
import mergeStrings from '../unminify/transforms/merge-strings';
import { findArrayRotator } from './array-rotator';
import controlFlowObject from './control-flow-object';
import controlFlowSwitch from './control-flow-switch';
import deadCode from './dead-code';
import { findDecoders } from './decoder';
import inlineDecodedStrings from './inline-decoded-strings';
import inlineDecoderWrappers from './inline-decoder-wrappers';
import inlineObjectProps from './inline-object-props';
import { findStringArray } from './string-array';
import type { Sandbox } from './vm';
import { VMDecoder, createBrowserSandbox, createNodeSandbox } from './vm';
export { createBrowserSandbox, createNodeSandbox, type Sandbox };
export default {
  name: 'deobfuscate',
  tags: ['unsafe'],
  scope: true,
  async run(ast, state, sandbox) {
    if (!sandbox) return;
    const logger = debug('webcrack:deobfuscate');
    const stringArray = findStringArray(ast);
    logger(
      stringArray
        ? `String Array: ${stringArray.originalName}, length ${stringArray.length}`
        : 'String Array: no',
    );
    if (!stringArray) return;
    const rotator = findArrayRotator(stringArray);
    logger(`String Array Rotate: ${rotator ? 'yes' : 'no'}`);
    const decoders = findDecoders(stringArray);
    logger(
      `String Array Decoders: ${decoders
        .map((d) => d.originalName)
        .join(', ')}`,
    );
    state.changes += applyTransform(ast, inlineObjectProps).changes;
    for (const decoder of decoders) {
      state.changes += applyTransform(
        ast,
        inlineDecoderWrappers,
        decoder.path,
      ).changes;
    }
    const vm = new VMDecoder(sandbox, stringArray, decoders, rotator);
    state.changes += (
      await applyTransformAsync(ast, inlineDecodedStrings, { vm })
    ).changes;
    if (decoders.length > 0) {
      stringArray.path.remove();
      rotator?.remove();
      decoders.forEach((decoder) => decoder.path.remove());
      state.changes += 2 + decoders.length;
    }
    state.changes += applyTransforms(
      ast,
      [mergeStrings, deadCode, controlFlowObject, controlFlowSwitch],
      { noScope: true },
    ).changes;
  },
} satisfies AsyncTransform<Sandbox>;
````

## File: deobfuscate/inline-decoded-strings.ts
````typescript
import * as t from '@babel/types';
import type { AsyncTransform } from '../ast-utils';
import type { VMDecoder } from './vm';
export default {
  name: 'inline-decoded-strings',
  tags: ['unsafe'],
  scope: true,
  async run(ast, state, options) {
    if (!options) return;
    const calls = options.vm.decoders.flatMap((decoder) =>
      decoder.collectCalls(),
    );
    const decodedValues = await options.vm.decode(calls);
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const value = decodedValues[i];
      call.replaceWith(t.valueToNode(value));
      if (typeof value !== 'string')
        call.addComment('leading', 'webcrack:decode_error');
    }
    state.changes += calls.length;
  },
} satisfies AsyncTransform<{ vm: VMDecoder }>;
````

## File: deobfuscate/inline-decoder-wrappers.ts
````typescript
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import type { Transform } from '../ast-utils';
import { inlineFunctionAliases, inlineVariableAliases } from '../ast-utils';
export default {
  name: 'inline-decoder-wrappers',
  tags: ['unsafe'],
  scope: true,
  run(ast, state, decoder) {
    if (!decoder?.node.id) return;
    const decoderName = decoder.node.id.name;
    const decoderBinding = decoder.parentPath.scope.getBinding(decoderName);
    if (decoderBinding) {
      state.changes += inlineVariableAliases(decoderBinding).changes;
      state.changes += inlineFunctionAliases(decoderBinding).changes;
    }
  },
} satisfies Transform<NodePath<t.FunctionDeclaration>>;
````

## File: deobfuscate/inline-object-props.ts
````typescript
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
import {
  constKey,
  constMemberExpression,
  getPropName,
  inlineObjectProperties,
  isReadonlyObject,
} from '../ast-utils';
export default {
  name: 'inline-object-props',
  tags: ['safe'],
  scope: true,
  visitor() {
    const varId = m.capture(m.identifier());
    const propertyName = m.capture(
      m.matcher<string>((name) => /^[\w]+$/i.test(name)),
    );
    const propertyKey = constKey(propertyName);
    const objectProperties = m.capture(
      m.arrayOf(
        m.objectProperty(
          propertyKey,
          m.or(m.stringLiteral(), m.numericLiteral()),
        ),
      ),
    );
    const memberAccess = constMemberExpression(
      m.fromCapture(varId),
      propertyName,
    );
    const varMatcher = m.variableDeclarator(
      varId,
      m.objectExpression(objectProperties),
    );
    const literalMemberAccess = constMemberExpression(
      m.objectExpression(objectProperties),
      propertyName,
    );
    return {
      MemberExpression(path) {
        if (!literalMemberAccess.match(path.node)) return;
        const property = objectProperties.current!.find(
          (p) => getPropName(p.key) === propertyName.current,
        );
        if (!property) return;
        path.replaceWith(property.value);
        this.changes++;
      },
      VariableDeclarator(path) {
        if (!varMatcher.match(path.node)) return;
        if (objectProperties.current!.length === 0) return;
        const binding = path.scope.getBinding(varId.current!.name);
        if (!binding || !isReadonlyObject(binding, memberAccess)) return;
        inlineObjectProperties(
          binding,
          m.objectProperty(
            propertyKey,
            m.or(m.stringLiteral(), m.numericLiteral()),
          ),
        );
        this.changes++;
      },
    };
  },
} satisfies Transform;
````

## File: deobfuscate/merge-object-assignments.ts
````typescript
import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
import { constObjectProperty, findParent, safeLiteral } from '../ast-utils';
export default {
  name: 'merge-object-assignments',
  tags: ['safe'],
  scope: true,
  visitor: () => {
    const id = m.capture(m.identifier());
    const object = m.capture(m.objectExpression([]));
    const varMatcher = m.variableDeclaration(undefined, [
      m.variableDeclarator(id, object),
    ]);
    const key = m.capture(m.anyExpression());
    const computed = m.capture<boolean>(m.anything());
    const value = m.capture(m.anyExpression());
    const assignmentMatcher = m.expressionStatement(
      m.assignmentExpression(
        '=',
        m.memberExpression(m.fromCapture(id), key, computed),
        value,
      ),
    );
    return {
      Program(path) {
        path.scope.crawl();
      },
      VariableDeclaration: {
        exit(path) {
          if (!path.inList || !varMatcher.match(path.node)) return;
          const binding = path.scope.getBinding(id.current!.name)!;
          const container = path.container as t.Statement[];
          const siblingIndex = (path.key as number) + 1;
          while (siblingIndex < container.length) {
            const sibling = path.getSibling(siblingIndex);
            if (
              !assignmentMatcher.match(sibling.node) ||
              hasCircularReference(value.current!, binding)
            )
              return;
            const isComputed =
              computed.current! &&
              key.current!.type !== 'NumericLiteral' &&
              key.current!.type !== 'StringLiteral';
            object.current!.properties.push(
              t.objectProperty(key.current!, value.current!, isComputed),
            );
            sibling.remove();
            binding.dereference();
            binding.referencePaths.shift();
            if (
              binding.references === 1 &&
              inlineableObject.match(object.current) &&
              !isRepeatedCallReference(binding, binding.referencePaths[0])
            ) {
              binding.referencePaths[0].replaceWith(object.current);
              path.remove();
              this.changes++;
            }
          }
        },
      },
    };
  },
} satisfies Transform;
function hasCircularReference(node: t.Node, binding: Binding) {
  return (
    binding.referencePaths.some((path) => path.find((p) => p.node === node)) ||
    m.containerOf(m.callExpression()).match(node)
  );
}
const repeatedCallMatcher = m.or(
  m.forStatement(),
  m.forOfStatement(),
  m.forInStatement(),
  m.whileStatement(),
  m.doWhileStatement(),
  m.function(),
  m.objectMethod(),
  m.classBody(),
);
function isRepeatedCallReference(binding: Binding, reference: NodePath) {
  const block = binding.scope.getBlockParent().path;
  const repeatable = findParent(reference, repeatedCallMatcher);
  return repeatable?.isDescendant(block);
}
const inlineableObject: m.Matcher<t.Expression> = m.matcher((node) =>
  m
    .or(
      safeLiteral,
      m.arrayExpression(m.arrayOf(inlineableObject)),
      m.objectExpression(m.arrayOf(constObjectProperty(inlineableObject))),
    )
    .match(node),
);
````

## File: deobfuscate/self-defending.ts
````typescript
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
import {
  constMemberExpression,
  falseMatcher,
  findParent,
  iife,
  trueMatcher,
} from '../ast-utils';
export default {
  name: 'self-defending',
  tags: ['safe'],
  scope: true,
  visitor() {
    const callController = m.capture(m.anyString());
    const firstCall = m.capture(m.identifier());
    const rfn = m.capture(m.identifier());
    const context = m.capture(m.identifier());
    const res = m.capture(m.identifier());
    const fn = m.capture(m.identifier());
    const matcher = m.variableDeclarator(
      m.identifier(callController),
      iife(
        [],
        m.blockStatement([
          m.variableDeclaration(undefined, [
            m.variableDeclarator(firstCall, trueMatcher),
          ]),
          m.returnStatement(
            m.functionExpression(
              null,
              [context, fn],
              m.blockStatement([
                m.variableDeclaration(undefined, [
                  m.variableDeclarator(
                    rfn,
                    m.conditionalExpression(
                      m.fromCapture(firstCall),
                      m.functionExpression(
                        null,
                        [],
                        m.blockStatement([
                          m.ifStatement(
                            m.fromCapture(fn),
                            m.blockStatement([
                              m.variableDeclaration(undefined, [
                                m.variableDeclarator(
                                  res,
                                  m.callExpression(
                                    constMemberExpression(
                                      m.fromCapture(fn),
                                      'apply',
                                    ),
                                    [
                                      m.fromCapture(context),
                                      m.identifier('arguments'),
                                    ],
                                  ),
                                ),
                              ]),
                              m.expressionStatement(
                                m.assignmentExpression(
                                  '=',
                                  m.fromCapture(fn),
                                  m.nullLiteral(),
                                ),
                              ),
                              m.returnStatement(m.fromCapture(res)),
                            ]),
                          ),
                        ]),
                      ),
                      m.functionExpression(null, [], m.blockStatement([])),
                    ),
                  ),
                ]),
                m.expressionStatement(
                  m.assignmentExpression(
                    '=',
                    m.fromCapture(firstCall),
                    falseMatcher,
                  ),
                ),
                m.returnStatement(m.fromCapture(rfn)),
              ]),
            ),
          ),
        ]),
      ),
    );
    const emptyIife = iife([], m.blockStatement([]));
    return {
      VariableDeclarator(path) {
        if (!matcher.match(path.node)) return;
        const binding = path.scope.getBinding(callController.current!);
        if (!binding) return;
        binding.referencePaths
          .filter((ref) => ref.parent.type === 'CallExpression')
          .forEach((ref) => {
            if (ref.parentPath?.parent.type === 'CallExpression') {
              ref.parentPath.parentPath?.remove();
            } else {
              removeSelfDefendingRefs(ref as NodePath<t.Identifier>);
            }
            findParent(ref, emptyIife)?.remove();
            this.changes++;
          });
        path.remove();
        this.changes++;
      },
    };
  },
} satisfies Transform;
function removeSelfDefendingRefs(path: NodePath<t.Identifier>) {
  const varName = m.capture(m.anyString());
  const varMatcher = m.variableDeclarator(
    m.identifier(varName),
    m.callExpression(m.identifier(path.node.name)),
  );
  const callMatcher = m.expressionStatement(
    m.callExpression(m.identifier(m.fromCapture(varName)), []),
  );
  const varDecl = findParent(path, varMatcher);
  if (varDecl) {
    const binding = varDecl.scope.getBinding(varName.current!);
    binding?.referencePaths.forEach((ref) => {
      if (callMatcher.match(ref.parentPath?.parent))
        ref.parentPath?.parentPath?.remove();
    });
    varDecl.remove();
  }
}
````

## File: deobfuscate/string-array.ts
````typescript
import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import type * as t from '@babel/types';
import * as m from '@codemod/matchers';
import {
  inlineArrayElements,
  isReadonlyObject,
  renameFast,
  undefinedMatcher,
} from '../ast-utils';
export interface StringArray {
  path: NodePath<t.FunctionDeclaration>;
  references: NodePath[];
  name: string;
  originalName: string;
  length: number;
}
export function findStringArray(ast: t.Node): StringArray | undefined {
  let result: StringArray | undefined;
  const functionName = m.capture(m.anyString());
  const arrayIdentifier = m.capture(m.identifier());
  const arrayExpression = m.capture(
    m.arrayExpression(m.arrayOf(m.or(m.stringLiteral(), undefinedMatcher))),
  );
  const functionAssignment = m.assignmentExpression(
    '=',
    m.identifier(m.fromCapture(functionName)),
    m.functionExpression(
      undefined,
      [],
      m.blockStatement([m.returnStatement(m.fromCapture(arrayIdentifier))]),
    ),
  );
  const variableDeclaration = m.variableDeclaration(undefined, [
    m.variableDeclarator(arrayIdentifier, arrayExpression),
  ]);
  const matcher = m.functionDeclaration(
    m.identifier(functionName),
    [],
    m.or(
      m.blockStatement([
        variableDeclaration,
        m.returnStatement(m.callExpression(functionAssignment)),
      ]),
      m.blockStatement([
        variableDeclaration,
        m.expressionStatement(functionAssignment),
        m.returnStatement(m.callExpression(m.identifier(functionName))),
      ]),
    ),
  );
  traverse(ast, {
    FunctionDeclaration(path) {
      if (matcher.match(path.node)) {
        const length = arrayExpression.current!.elements.length;
        const name = functionName.current!;
        const binding = path.scope.getBinding(name)!;
        renameFast(binding, '__STRING_ARRAY__');
        result = {
          path,
          references: binding.referencePaths,
          originalName: name,
          name: '__STRING_ARRAY__',
          length,
        };
        path.stop();
      }
    },
    VariableDeclaration(path) {
      if (!variableDeclaration.match(path.node)) return;
      const length = arrayExpression.current!.elements.length;
      const binding = path.scope.getBinding(arrayIdentifier.current!.name)!;
      const memberAccess = m.memberExpression(
        m.fromCapture(arrayIdentifier),
        m.numericLiteral(m.matcher((value) => value < length)),
      );
      if (!binding.referenced || !isReadonlyObject(binding, memberAccess))
        return;
      inlineArrayElements(arrayExpression.current!, binding.referencePaths);
      path.remove();
    },
  });
  return result;
}
````

## File: deobfuscate/var-functions.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
export default {
  name: 'var-functions',
  tags: ['unsafe'],
  visitor() {
    const name = m.capture(m.identifier());
    const fn = m.capture(m.functionExpression(null));
    const matcher = m.variableDeclaration('var', [
      m.variableDeclarator(name, fn),
    ]);
    return {
      VariableDeclaration: {
        exit(path) {
          if (matcher.match(path.node) && path.key !== 'init') {
            path.replaceWith(
              t.functionDeclaration(
                name.current,
                fn.current!.params,
                fn.current!.body,
                fn.current!.generator,
                fn.current!.async,
              ),
            );
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: deobfuscate/vm.ts
````typescript
import type { NodePath } from '@babel/traverse';
import type { CallExpression } from '@babel/types';
import debug from 'debug';
import { generate } from '../ast-utils';
import type { ArrayRotator } from './array-rotator';
import type { Decoder } from './decoder';
import type { StringArray } from './string-array';
export type Sandbox = (code: string) => Promise<unknown>;
export function createNodeSandbox(): Sandbox {
  return async (code: string) => {
    const {
      default: { Isolate },
    } = await import('isolated-vm');
    const isolate = new Isolate();
    const context = await isolate.createContext();
    const result = (await context.eval(code, {
      timeout: 10_000,
      copy: true,
      filename: 'file:///obfuscated.js',
    })) as unknown;
    context.release();
    isolate.dispose();
    return result;
  };
}
export function createBrowserSandbox(): Sandbox {
  return () => {
    throw new Error('Custom Sandbox implementation required.');
  };
}
export class VMDecoder {
  decoders: Decoder[];
  private setupCode: string;
  private sandbox: Sandbox;
  constructor(
    sandbox: Sandbox,
    stringArray: StringArray,
    decoders: Decoder[],
    rotator?: ArrayRotator,
  ) {
    this.sandbox = sandbox;
    this.decoders = decoders;
    const generateOptions = {
      compact: true,
      shouldPrintComment: () => false,
    };
    const stringArrayCode = generate(stringArray.path.node, generateOptions);
    const rotatorCode = rotator ? generate(rotator.node, generateOptions) : '';
    const decoderCode = decoders
      .map((decoder) => generate(decoder.path.node, generateOptions))
      .join(';\n');
    this.setupCode = [stringArrayCode, rotatorCode, decoderCode].join(';\n');
  }
  async decode(calls: NodePath<CallExpression>[]): Promise<unknown[]> {
    const code = `(() => {
      ${this.setupCode}
      return [${calls.join(',')}]
    })()`;
    try {
      const result = await this.sandbox(code);
      return result as unknown[];
    } catch (error) {
      debug('webcrack:deobfuscate')('vm code:', code);
      if (
        error instanceof Error &&
        (error.message.includes('undefined symbol') ||
          error.message.includes('Segmentation fault'))
      ) {
        throw new Error(
          'isolated-vm version mismatch. Check https://webcrack.netlify.app/docs/guide/common-errors.html#isolated-vm',
          { cause: error },
        );
      }
      throw error;
    }
  }
}
````

## File: index.ts
````typescript
import type { ParseResult } from '@babel/parser';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type Matchers from '@codemod/matchers';
import * as m from '@codemod/matchers';
import debug from 'debug';
import { join, normalize } from 'node:path';
import {
  applyTransform,
  applyTransformAsync,
  applyTransforms,
  generate,
} from './ast-utils';
import type { Sandbox } from './deobfuscate';
import deobfuscate, {
  createBrowserSandbox,
  createNodeSandbox,
} from './deobfuscate';
import debugProtection from './deobfuscate/debug-protection';
import evaluateGlobals from './deobfuscate/evaluate-globals';
import mergeObjectAssignments from './deobfuscate/merge-object-assignments';
import selfDefending from './deobfuscate/self-defending';
import varFunctions from './deobfuscate/var-functions';
import {
  runPlugins,
  type Plugin,
  type PluginState,
  type Stage,
} from './plugin';
import jsx from './transforms/jsx';
import jsxNew from './transforms/jsx-new';
import mangle from './transforms/mangle';
import transpile from './transpile';
import unminify from './unminify';
import {
  blockStatements,
  sequence,
  splitVariableDeclarations,
} from './unminify/transforms';
import type { Bundle } from './unpack';
import { unpackAST } from './unpack';
import { isBrowser } from './utils/platform';
export { type Sandbox } from './deobfuscate';
export type { Plugin } from './plugin';
type Matchers = typeof m;
export interface WebcrackResult {
  code: string;
  bundle: Bundle | undefined;
  save(path: string): Promise<void>;
}
export interface Options {
  jsx?: boolean;
  unpack?: boolean;
  deobfuscate?: boolean;
  unminify?: boolean;
  mangle?: boolean | ((id: string) => boolean);
  plugins?: Partial<Record<Stage, Plugin[]>>;
  mappings?: (m: Matchers) => Record<string, m.Matcher<unknown>>;
  sandbox?: Sandbox;
  onProgress?: (progress: number) => void;
}
function mergeOptions(options: Options): asserts options is Required<Options> {
  const mergedOptions: Required<Options> = {
    jsx: true,
    unminify: true,
    unpack: true,
    deobfuscate: true,
    mangle: false,
    plugins: options.plugins ?? {},
    mappings: () => ({}),
    onProgress: () => {},
    sandbox: isBrowser() ? createBrowserSandbox() : createNodeSandbox(),
    ...options,
  };
  Object.assign(options, mergedOptions);
}
export async function webcrack(
  code: string,
  options: Options = {},
): Promise<WebcrackResult> {
  mergeOptions(options);
  options.onProgress(0);
  if (isBrowser()) {
    debug.enable('webcrack:*');
  }
  const isBookmarklet = /^javascript:./.test(code);
  if (isBookmarklet) {
    code = code
      .replace(/^javascript:/, '')
      .split(/%(?![a-f\d]{2})/i)
      .map(decodeURIComponent)
      .join('%');
  }
  let ast: ParseResult<t.File> = null!;
  let outputCode = '';
  let bundle: Bundle | undefined;
  const { plugins } = options;
  const state: PluginState = { opts: {} };
  const stages = [
    () => {
      ast = parse(code, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: ['jsx'],
      });
      if (ast.errors?.length) {
        debug('webcrack:parse')('Recovered from parse errors', ast.errors);
      }
    },
    plugins.afterParse && (() => runPlugins(ast, plugins.afterParse!, state)),
    () => {
      applyTransforms(
        ast,
        [blockStatements, sequence, splitVariableDeclarations, varFunctions],
        { name: 'prepare' },
      );
    },
    plugins.afterPrepare &&
      (() => runPlugins(ast, plugins.afterPrepare!, state)),
    options.deobfuscate &&
      (() => applyTransformAsync(ast, deobfuscate, options.sandbox)),
    plugins.afterDeobfuscate &&
      (() => runPlugins(ast, plugins.afterDeobfuscate!, state)),
    options.unminify &&
      (() => {
        applyTransforms(ast, [transpile, unminify]);
      }),
    plugins.afterUnminify &&
      (() => runPlugins(ast, plugins.afterUnminify!, state)),
    options.mangle &&
      (() =>
        applyTransform(
          ast,
          mangle,
          typeof options.mangle === 'boolean' ? () => true : options.mangle,
        )),
    (options.deobfuscate || options.jsx) &&
      (() => {
        applyTransforms(
          ast,
          [
            options.deobfuscate ? [selfDefending, debugProtection] : [],
            options.jsx ? [jsx, jsxNew] : [],
          ].flat(),
        );
      }),
    options.deobfuscate &&
      (() => applyTransforms(ast, [mergeObjectAssignments, evaluateGlobals])),
    () => (outputCode = generate(ast)),
    options.unpack && (() => (bundle = unpackAST(ast, options.mappings(m)))),
    plugins.afterUnpack && (() => runPlugins(ast, plugins.afterUnpack!, state)),
  ].filter(Boolean) as (() => unknown)[];
  for (let i = 0; i < stages.length; i++) {
    await stages[i]();
    options.onProgress((100 / stages.length) * (i + 1));
  }
  return {
    code: outputCode,
    bundle,
    async save(path) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      path = normalize(path);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'deobfuscated.js'), outputCode, 'utf8');
      await bundle?.save(path);
    },
  };
}
````

## File: plugin.ts
````typescript
import { parse } from '@babel/parser';
import template from '@babel/template';
import traverse, { visitors, type Visitor } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
export type Stage =
  | 'afterParse'
  | 'afterPrepare'
  | 'afterDeobfuscate'
  | 'afterUnminify'
  | 'afterUnpack';
export type PluginState = { opts: Record<string, unknown> };
export interface PluginObject {
  name?: string;
  pre?: (this: PluginState, state: PluginState) => Promise<void> | void;
  post?: (this: PluginState, state: PluginState) => Promise<void> | void;
  visitor?: Visitor<PluginState>;
}
export interface PluginAPI {
  parse: typeof parse;
  types: typeof t;
  traverse: typeof traverse;
  template: typeof template;
  matchers: typeof m;
}
export type Plugin = (api: PluginAPI) => PluginObject;
export async function runPlugins(
  ast: t.File,
  plugins: Plugin[],
  state: PluginState,
): Promise<void> {
  const pluginObjects = plugins.map((plugin) =>
    plugin({
      parse,
      types: t,
      traverse,
      template,
      matchers: m,
    }),
  );
  for (const plugin of pluginObjects) {
    await plugin.pre?.call(state, state);
  }
  const pluginVisitors = pluginObjects.flatMap(
    (plugin) => plugin.visitor ?? [],
  );
  if (pluginVisitors.length > 0) {
    const mergedVisitor = visitors.merge(pluginVisitors);
    traverse(ast, mergedVisitor, undefined, state);
  }
  for (const plugin of pluginObjects) {
    await plugin.post?.call(state, state);
  }
}
````

## File: transforms/jsx-new.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
import { codePreview, constMemberExpression } from '../ast-utils';
import { generateUid } from '../ast-utils/scope';
const DEFAULT_PRAGMA_CANDIDATES = [
  'jsx',
  'jsxs',
  '_jsx',
  '_jsxs',
  'jsxDEV',
  'jsxsDEV',
] as const;
export default {
  name: 'jsx-new',
  tags: ['unsafe'],
  scope: true,
  visitor: () => {
    const deepIdentifierMemberExpression = m.memberExpression(
      m.or(
        m.identifier(),
        m.matcher((node) => deepIdentifierMemberExpression.match(node)),
      ),
      m.identifier(),
      false,
    );
    const convertibleName = m.or(
      m.identifier(),
      m.stringLiteral(),
      deepIdentifierMemberExpression,
    );
    const type = m.capture(m.anyExpression());
    const fragmentType = constMemberExpression('React', 'Fragment');
    const props = m.capture(m.objectExpression());
    const key = m.capture(m.anyExpression());
    const jsxFunction = m.capture(m.or(...DEFAULT_PRAGMA_CANDIDATES));
    const jsxMatcher = m.callExpression(
      m.or(
        m.identifier(jsxFunction),
        m.sequenceExpression([
          m.numericLiteral(0),
          constMemberExpression(m.identifier(), jsxFunction),
        ]),
        constMemberExpression(m.identifier(), jsxFunction),
      ),
      m.anyList(type, props, m.slice({ min: 0, max: 1, matcher: key })),
    );
    return {
      CallExpression: {
        exit(path) {
          if (!jsxMatcher.match(path.node)) return;
          let name: t.Node;
          if (convertibleName.match(type.current!)) {
            name = convertType(type.current);
          } else {
            name = t.jsxIdentifier(generateUid(path.scope, 'Component'));
            const componentVar = t.variableDeclaration('const', [
              t.variableDeclarator(t.identifier(name.name), type.current),
            ]);
            path.getStatementParent()?.insertBefore(componentVar);
          }
          const isFragment = fragmentType.match(type.current);
          if (
            t.isIdentifier(type.current) &&
            /^[a-z]/.test(type.current.name)
          ) {
            const binding = path.scope.getBinding(type.current.name);
            if (!binding) return;
            name = t.jsxIdentifier(path.scope.generateUid('Component'));
            path.scope.rename(type.current.name, name.name);
          }
          const attributes = convertAttributes(props.current!);
          if (path.node.arguments.length === 3) {
            attributes.push(
              t.jsxAttribute(
                t.jsxIdentifier('key'),
                convertAttributeValue(key.current!),
              ),
            );
          }
          const children = convertChildren(
            props.current!,
            jsxFunction.current!,
          );
          if (isFragment && attributes.length === 0) {
            const opening = t.jsxOpeningFragment();
            const closing = t.jsxClosingFragment();
            const fragment = t.jsxFragment(opening, closing, children);
            path.node.leadingComments = null;
            path.replaceWith(fragment);
          } else {
            const selfClosing = children.length === 0;
            const opening = t.jsxOpeningElement(name, attributes, selfClosing);
            const closing = t.jsxClosingElement(name);
            const element = t.jsxElement(opening, closing, children);
            path.node.leadingComments = null;
            path.replaceWith(element);
          }
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
function convertType(
  type: t.Identifier | t.MemberExpression | t.StringLiteral,
): t.JSXIdentifier | t.JSXMemberExpression {
  if (t.isIdentifier(type)) {
    return t.jsxIdentifier(type.name);
  } else if (t.isStringLiteral(type)) {
    return t.jsxIdentifier(type.value);
  } else {
    const object = convertType(
      type.object as t.Identifier | t.MemberExpression,
    );
    const property = t.jsxIdentifier((type.property as t.Identifier).name);
    return t.jsxMemberExpression(object, property);
  }
}
function convertAttributes(
  object: t.ObjectExpression,
): (t.JSXAttribute | t.JSXSpreadAttribute)[] {
  const name = m.capture(m.anyString());
  const value = m.capture(m.anyExpression());
  const matcher = m.objectProperty(
    m.or(m.identifier(name), m.stringLiteral(name)),
    value,
  );
  return object.properties.flatMap((property) => {
    if (matcher.match(property)) {
      if (name.current === 'children') return [];
      const jsxName = t.jsxIdentifier(name.current!);
      const jsxValue = convertAttributeValue(value.current!);
      return t.jsxAttribute(jsxName, jsxValue);
    } else if (t.isSpreadElement(property)) {
      return t.jsxSpreadAttribute(property.argument);
    } else {
      throw new Error(
        `jsx: property type not implemented ${codePreview(object)}`,
      );
    }
  });
}
function convertAttributeValue(
  expression: t.Expression,
): t.JSXExpressionContainer | t.StringLiteral {
  if (expression.type === 'StringLiteral') {
    const hasSpecialChars = /["\\]/.test(expression.value);
    return hasSpecialChars ? t.jsxExpressionContainer(expression) : expression;
  }
  return t.jsxExpressionContainer(expression);
}
function convertChildren(
  object: t.ObjectExpression,
  pragma: string,
): (t.JSXText | t.JSXElement | t.JSXExpressionContainer)[] {
  const children = m.capture(m.anyExpression());
  const matcher = m.objectProperty(
    m.or(m.identifier('children'), m.stringLiteral('children')),
    children,
  );
  const prop = object.properties.find((prop) => matcher.match(prop));
  if (!prop) return [];
  if (pragma.includes('jsxs') && t.isArrayExpression(children.current)) {
    return children.current.elements.map((child) =>
      convertChild(child as t.Expression),
    );
  }
  return [convertChild(children.current!)];
}
function convertChild(
  child: t.Expression,
): t.JSXElement | t.JSXExpressionContainer | t.JSXText {
  if (t.isJSXElement(child)) {
    return child;
  } else if (t.isStringLiteral(child)) {
    const hasSpecialChars = /[{}<>\r\n]/.test(child.value);
    return hasSpecialChars
      ? t.jsxExpressionContainer(child)
      : t.jsxText(child.value);
  } else {
    return t.jsxExpressionContainer(child);
  }
}
````

## File: transforms/jsx.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../ast-utils';
import { codePreview, constMemberExpression } from '../ast-utils';
import { generateUid } from '../ast-utils/scope';
export default {
  name: 'jsx',
  tags: ['unsafe'],
  scope: true,
  visitor: () => {
    const deepIdentifierMemberExpression = m.memberExpression(
      m.or(
        m.identifier(),
        m.matcher((node) => deepIdentifierMemberExpression.match(node)),
      ),
      m.identifier(),
      false,
    );
    const type = m.capture(
      m.or(
        m.identifier(),
        m.stringLiteral(),
        deepIdentifierMemberExpression,
      ),
    );
    const props = m.capture(m.or(m.objectExpression(), m.nullLiteral()));
    const elementMatcher = m.callExpression(
      constMemberExpression('React', 'createElement'),
      m.anyList(
        type,
        props,
        m.zeroOrMore(m.or(m.anyExpression(), m.spreadElement())),
      ),
    );
    const fragmentMatcher = m.callExpression(
      constMemberExpression('React', 'createElement'),
      m.anyList(
        constMemberExpression('React', 'Fragment'),
        m.nullLiteral(),
        m.zeroOrMore(m.or(m.anyExpression(), m.spreadElement())),
      ),
    );
    return {
      CallExpression: {
        exit(path) {
          if (fragmentMatcher.match(path.node)) {
            const children = convertChildren(
              path.node.arguments.slice(2) as t.Expression[],
            );
            const opening = t.jsxOpeningFragment();
            const closing = t.jsxClosingFragment();
            const fragment = t.jsxFragment(opening, closing, children);
            path.node.leadingComments = null;
            path.replaceWith(fragment);
            this.changes++;
          }
          if (elementMatcher.match(path.node)) {
            let name = convertType(type.current!);
            if (
              t.isIdentifier(type.current) &&
              /^[a-z]/.test(type.current.name)
            ) {
              const binding = path.scope.getBinding(type.current.name);
              if (!binding) return;
              name = t.jsxIdentifier(generateUid(path.scope, 'Component'));
              path.scope.rename(type.current.name, name.name);
            }
            const attributes = t.isObjectExpression(props.current)
              ? convertAttributes(props.current)
              : [];
            const children = convertChildren(
              path.node.arguments.slice(2) as t.Expression[],
            );
            const selfClosing = children.length === 0;
            const opening = t.jsxOpeningElement(name, attributes, selfClosing);
            const closing = t.jsxClosingElement(name);
            const element = t.jsxElement(opening, closing, children);
            path.node.leadingComments = null;
            path.replaceWith(element);
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
function convertType(
  type: t.Identifier | t.MemberExpression | t.StringLiteral,
): t.JSXIdentifier | t.JSXMemberExpression {
  if (t.isIdentifier(type)) {
    return t.jsxIdentifier(type.name);
  } else if (t.isStringLiteral(type)) {
    return t.jsxIdentifier(type.value);
  } else {
    const object = convertType(
      type.object as t.Identifier | t.MemberExpression,
    );
    const property = t.jsxIdentifier((type.property as t.Identifier).name);
    return t.jsxMemberExpression(object, property);
  }
}
function convertAttributes(
  object: t.ObjectExpression,
): (t.JSXAttribute | t.JSXSpreadAttribute)[] {
  const name = m.capture(m.anyString());
  const value = m.capture(m.anyExpression());
  const matcher = m.objectProperty(
    m.or(m.identifier(name), m.stringLiteral(name)),
    value,
  );
  return object.properties.map((property) => {
    if (matcher.match(property)) {
      const jsxName = t.jsxIdentifier(name.current!);
      if (value.current!.type === 'StringLiteral') {
        const hasSpecialChars = /["\\]/.test(value.current.value);
        const jsxValue = hasSpecialChars
          ? t.jsxExpressionContainer(value.current)
          : value.current;
        return t.jsxAttribute(jsxName, jsxValue);
      }
      const jsxValue = t.jsxExpressionContainer(value.current!);
      return t.jsxAttribute(jsxName, jsxValue);
    } else if (t.isSpreadElement(property)) {
      return t.jsxSpreadAttribute(property.argument);
    } else {
      throw new Error(
        `jsx: property type not implemented ${codePreview(object)}`,
      );
    }
  });
}
function convertChildren(
  children: (t.Expression | t.SpreadElement)[],
): (t.JSXText | t.JSXElement | t.JSXSpreadChild | t.JSXExpressionContainer)[] {
  return children.map((child) => {
    if (t.isJSXElement(child)) {
      return child;
    } else if (t.isStringLiteral(child)) {
      const hasSpecialChars = /[{}<>\r\n]/.test(child.value);
      return hasSpecialChars
        ? t.jsxExpressionContainer(child)
        : t.jsxText(child.value);
    } else if (t.isSpreadElement(child)) {
      return t.jsxSpreadChild(child.argument);
    } else {
      return t.jsxExpressionContainer(child);
    }
  });
}
````

## File: transforms/mangle.ts
````typescript
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { renameFast, type Transform } from '../ast-utils';
import { generateUid } from '../ast-utils/scope';
export default {
  name: 'mangle',
  tags: ['safe'],
  scope: true,
  visitor(match = () => true) {
    return {
      BindingIdentifier: {
        exit(path) {
          if (!path.isBindingIdentifier()) return;
          if (path.parentPath.isImportSpecifier()) return;
          if (path.parentPath.isObjectProperty()) return;
          if (!match(path.node.name)) return;
          const binding = path.scope.getBinding(path.node.name);
          if (!binding) return;
          if (
            binding.referencePaths.some((ref) => ref.isExportNamedDeclaration())
          )
            return;
          renameFast(binding, inferName(path));
        },
      },
    };
  },
} satisfies Transform<(id: string) => boolean>;
const requireMatcher = m.variableDeclarator(
  m.identifier(),
  m.callExpression(m.identifier('require'), [m.stringLiteral()]),
);
function inferName(path: NodePath<t.Identifier>): string {
  if (path.parentPath.isClass({ id: path.node })) {
    return generateUid(path.scope, 'C');
  } else if (path.parentPath.isFunction({ id: path.node })) {
    return generateUid(path.scope, 'f');
  } else if (
    path.listKey === 'params' ||
    (path.parentPath.isAssignmentPattern({ left: path.node }) &&
      path.parentPath.listKey === 'params')
  ) {
    return generateUid(path.scope, 'p');
  } else if (requireMatcher.match(path.parent)) {
    return generateUid(
      path.scope,
      (path.parentPath.get('init.arguments.0') as NodePath<t.StringLiteral>)
        .node.value,
    );
  } else if (path.parentPath.isVariableDeclarator({ id: path.node })) {
    const init = path.parentPath.get('init');
    const suffix = (init.isExpression() && generateExpressionName(init)) || '';
    return generateUid(path.scope, 'v' + titleCase(suffix));
  } else if (path.parentPath.isCatchClause()) {
    return generateUid(path.scope, 'e');
  } else if (path.parentPath.isArrayPattern()) {
    return generateUid(path.scope, 'v');
  } else {
    return path.node.name;
  }
}
function generateExpressionName(
  expression: NodePath<t.Expression>,
): string | undefined {
  if (expression.isIdentifier()) {
    return expression.node.name;
  } else if (expression.isFunctionExpression()) {
    return expression.node.id?.name ?? 'f';
  } else if (expression.isArrowFunctionExpression()) {
    return 'f';
  } else if (expression.isClassExpression()) {
    return expression.node.id?.name ?? 'C';
  } else if (expression.isCallExpression()) {
    return generateExpressionName(
      expression.get('callee') as NodePath<t.Expression>,
    );
  } else if (expression.isThisExpression()) {
    return 'this';
  } else if (expression.isNumericLiteral()) {
    return 'LN' + expression.node.value.toString();
  } else if (expression.isStringLiteral()) {
    return 'LS' + titleCase(expression.node.value).slice(0, 20);
  } else if (expression.isObjectExpression()) {
    return 'O';
  } else if (expression.isArrayExpression()) {
    return 'A';
  } else {
    return undefined;
  }
}
function titleCase(str: string) {
  return str
    .replace(/(?:^|\s)([a-z])/g, (_, m) => (m as string).toUpperCase())
    .replace(/[^a-zA-Z0-9$_]/g, '');
}
````

## File: transpile/index.ts
````typescript
import { mergeTransforms } from '../ast-utils';
import * as transforms from './transforms';
export default mergeTransforms({
  name: 'transpile',
  tags: ['safe'],
  transforms: Object.values(transforms),
});
````

## File: transpile/transforms/default-parameters.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { constMemberExpression, type Transform } from '../../ast-utils';
export default {
  name: 'default-parameters',
  tags: ['safe'],
  scope: true,
  visitor() {
    const defaultExpression = m.capture(m.anyExpression());
    const index = m.capture(m.numericLiteral());
    const varName = m.capture(m.identifier());
    const varId = m.capture(
      m.or(m.identifier(), m.arrayPattern(), m.objectPattern()),
    );
    const argumentCheckAnd = m.logicalExpression(
      '&&',
      m.binaryExpression(
        '>',
        constMemberExpression('arguments', 'length'),
        index,
      ),
      m.binaryExpression(
        '!==',
        m.memberExpression(
          m.identifier('arguments'),
          m.fromCapture(index),
          true,
        ),
        m.identifier('undefined'),
      ),
    );
    const argumentCheckOr = m.logicalExpression(
      '||',
      m.binaryExpression(
        '<=',
        constMemberExpression('arguments', 'length'),
        index,
      ),
      m.binaryExpression(
        '===',
        m.memberExpression(
          m.identifier('arguments'),
          m.fromCapture(index),
          true,
        ),
        m.identifier('undefined'),
      ),
    );
    const defaultParam = m.variableDeclaration(undefined, [
      m.variableDeclarator(
        varId,
        m.conditionalExpression(
          argumentCheckAnd,
          m.memberExpression(
            m.identifier('arguments'),
            m.fromCapture(index),
            true,
          ),
          defaultExpression,
        ),
      ),
    ]);
    const defaultFalseParam = m.variableDeclaration(undefined, [
      m.variableDeclarator(
        varId,
        m.logicalExpression(
          '&&',
          argumentCheckAnd,
          m.memberExpression(
            m.identifier('arguments'),
            m.fromCapture(index),
            true,
          ),
        ),
      ),
    ]);
    const defaultTrueParam = m.variableDeclaration(undefined, [
      m.variableDeclarator(
        varId,
        m.logicalExpression(
          '||',
          argumentCheckOr,
          m.memberExpression(
            m.identifier('arguments'),
            m.fromCapture(index),
            true,
          ),
        ),
      ),
    ]);
    const defaultParamLoose = m.ifStatement(
      m.binaryExpression('===', varName, m.identifier('undefined')),
      m.blockStatement([
        m.expressionStatement(
          m.assignmentExpression(
            '=',
            m.fromCapture(varName),
            defaultExpression,
          ),
        ),
      ]),
    );
    const normalParam = m.variableDeclaration(undefined, [
      m.variableDeclarator(
        varId,
        m.conditionalExpression(
          m.binaryExpression(
            '>',
            constMemberExpression('arguments', 'length'),
            index,
          ),
          m.memberExpression(
            m.identifier('arguments'),
            m.fromCapture(index),
            true,
          ),
          m.identifier('undefined'),
        ),
      ),
    ]);
    return {
      VariableDeclaration: {
        exit(path) {
          const fn = path.parentPath.parent;
          if (!t.isFunction(fn) || path.key !== 0) return;
          const newParam = defaultParam.match(path.node)
            ? t.assignmentPattern(varId.current!, defaultExpression.current!)
            : defaultFalseParam.match(path.node)
              ? t.assignmentPattern(varId.current!, t.booleanLiteral(false))
              : defaultTrueParam.match(path.node)
                ? t.assignmentPattern(varId.current!, t.booleanLiteral(true))
                : normalParam.match(path.node)
                  ? varId.current!
                  : null;
          if (!newParam) return;
          for (let i = fn.params.length; i < index.current!.value; i++) {
            fn.params[i] = t.identifier(path.scope.generateUid('param'));
          }
          fn.params[index.current!.value] = newParam;
          path.remove();
          this.changes++;
        },
      },
      IfStatement: {
        exit(path) {
          const fn = path.parentPath.parent;
          if (!t.isFunction(fn) || path.key !== 0) return;
          if (!defaultParamLoose.match(path.node)) return;
          const binding = path.scope.getOwnBinding(varName.current!.name);
          if (!binding) return;
          const isFunctionParam =
            binding.path.listKey === 'params' && binding.path.parent === fn;
          if (!isFunctionParam) return;
          binding.path.replaceWith(
            t.assignmentPattern(varName.current!, defaultExpression.current!),
          );
          path.remove();
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
````

## File: transpile/transforms/index.ts
````typescript
export { default as defaultParameters } from './default-parameters';
export { default as logicalAssignments } from './logical-assignments';
export { default as nullishCoalescing } from './nullish-coalescing';
export { default as nullishCoalescingAssignment } from './nullish-coalescing-assignment';
export { default as optionalChaining } from './optional-chaining';
export { default as templateLiterals } from './template-literals';
````

## File: transpile/transforms/logical-assignments.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
import { isTemporaryVariable } from '../../ast-utils';
export default {
  name: 'logical-assignments',
  tags: ['safe'],
  scope: true,
  visitor() {
    const operator = m.capture(m.or('||' as const, '&&' as const));
    const left = m.capture(m.or(m.identifier(), m.memberExpression()));
    const right = m.capture(m.anyExpression());
    const idMatcher = m.logicalExpression(
      operator,
      left,
      m.assignmentExpression('=', m.fromCapture(left), right),
    );
    const object = m.capture(m.anyExpression());
    const property = m.capture(m.anyExpression());
    const tmpVar = m.capture(m.identifier());
    const member = m.capture(
      m.memberExpression(m.fromCapture(tmpVar), m.fromCapture(property)),
    );
    const memberMatcher = m.logicalExpression(
      operator,
      m.memberExpression(m.assignmentExpression('=', tmpVar, object), property),
      m.assignmentExpression('=', member, right),
    );
    const computedMemberMatcher = m.logicalExpression(
      operator,
      m.memberExpression(
        object,
        m.assignmentExpression('=', tmpVar, property),
        true,
      ),
      m.assignmentExpression(
        '=',
        m.memberExpression(m.fromCapture(object), m.fromCapture(tmpVar), true),
        right,
      ),
    );
    const tmpVar2 = m.capture(m.identifier());
    const multiComputedMemberMatcher = m.logicalExpression(
      operator,
      m.memberExpression(
        m.assignmentExpression('=', tmpVar, object),
        m.assignmentExpression('=', tmpVar2, property),
        true,
      ),
      m.assignmentExpression(
        '=',
        m.memberExpression(m.fromCapture(tmpVar), m.fromCapture(tmpVar2), true),
        right,
      ),
    );
    return {
      LogicalExpression: {
        exit(path) {
          if (idMatcher.match(path.node)) {
            path.replaceWith(
              t.assignmentExpression(
                operator.current! + '=',
                left.current!,
                right.current!,
              ),
            );
            this.changes++;
          } else if (memberMatcher.match(path.node)) {
            const binding = path.scope.getBinding(tmpVar.current!.name);
            if (!isTemporaryVariable(binding, 1)) return;
            binding.path.remove();
            member.current!.object = object.current!;
            path.replaceWith(
              t.assignmentExpression(
                operator.current! + '=',
                member.current!,
                right.current!,
              ),
            );
            this.changes++;
          } else if (computedMemberMatcher.match(path.node)) {
            const binding = path.scope.getBinding(tmpVar.current!.name);
            if (!isTemporaryVariable(binding, 1)) return;
            binding.path.remove();
            path.replaceWith(
              t.assignmentExpression(
                operator.current! + '=',
                t.memberExpression(object.current!, property.current!, true),
                right.current!,
              ),
            );
            this.changes++;
          } else if (multiComputedMemberMatcher.match(path.node)) {
            const binding = path.scope.getBinding(tmpVar.current!.name);
            const binding2 = path.scope.getBinding(tmpVar2.current!.name);
            if (
              !isTemporaryVariable(binding, 1) ||
              !isTemporaryVariable(binding2, 1)
            )
              return;
            binding.path.remove();
            binding2.path.remove();
            path.replaceWith(
              t.assignmentExpression(
                operator.current! + '=',
                t.memberExpression(object.current!, property.current!, true),
                right.current!,
              ),
            );
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: transpile/transforms/nullish-coalescing-assignment.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
import { isTemporaryVariable } from '../../ast-utils';
export default {
  name: 'nullish-coalescing-assignment',
  tags: ['safe'],
  scope: true,
  visitor() {
    const tmpVar = m.capture(m.identifier());
    const leftId = m.capture(m.identifier());
    const property = m.capture(m.identifier());
    const right = m.capture(m.anyExpression());
    const computed = m.capture<boolean>(m.anything());
    const memberMatcher = m.logicalExpression(
      '??',
      m.memberExpression(
        m.assignmentExpression('=', tmpVar, leftId),
        property,
        computed,
      ),
      m.assignmentExpression(
        '=',
        m.memberExpression(
          m.fromCapture(tmpVar),
          m.fromCapture(property),
          computed,
        ),
        right,
      ),
    );
    const left = m.capture(m.or(m.identifier(), m.memberExpression()));
    const simpleMatcher = m.logicalExpression(
      '??',
      left,
      m.assignmentExpression('=', m.fromCapture(left), right),
    );
    return {
      LogicalExpression: {
        exit(path) {
          if (memberMatcher.match(path.node)) {
            const binding = path.scope.getBinding(tmpVar.current!.name);
            if (!isTemporaryVariable(binding, 1)) return;
            binding.path.remove();
            path.replaceWith(
              t.assignmentExpression(
                '??=',
                t.memberExpression(
                  leftId.current!,
                  property.current!,
                  computed.current,
                ),
                right.current!,
              ),
            );
            this.changes++;
          } else if (simpleMatcher.match(path.node)) {
            path.replaceWith(
              t.assignmentExpression('??=', left.current!, right.current!),
            );
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: transpile/transforms/nullish-coalescing.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
import { isTemporaryVariable } from '../../ast-utils';
export default {
  name: 'nullish-coalescing',
  tags: ['safe'],
  scope: true,
  visitor() {
    const tmpVar = m.capture(m.identifier());
    const left = m.capture(m.anyExpression());
    const right = m.capture(m.anyExpression());
    const idMatcher = m.conditionalExpression(
      m.logicalExpression(
        '&&',
        m.binaryExpression(
          '!==',
          m.assignmentExpression('=', tmpVar, left),
          m.nullLiteral(),
        ),
        m.binaryExpression(
          '!==',
          m.fromCapture(tmpVar),
          m.identifier('undefined'),
        ),
      ),
      m.fromCapture(tmpVar),
      right,
    );
    const idLooseMatcher = m.conditionalExpression(
      m.binaryExpression(
        '!=',
        m.assignmentExpression('=', tmpVar, left),
        m.nullLiteral(),
      ),
      m.fromCapture(tmpVar),
      right,
    );
    const simpleIdMatcher = m.conditionalExpression(
      m.or(
        m.logicalExpression(
          '&&',
          m.binaryExpression('!==', left, m.nullLiteral()),
          m.binaryExpression(
            '!==',
            m.fromCapture(left),
            m.identifier('undefined'),
          ),
        ),
        m.binaryExpression('!=', left, m.nullLiteral()),
      ),
      m.fromCapture(left),
      right,
    );
    const iifeMatcher = m.callExpression(
      m.arrowFunctionExpression(
        [m.fromCapture(tmpVar)],
        m.anyExpression(),
        false,
      ),
      [],
    );
    return {
      ConditionalExpression: {
        exit(path) {
          if (idMatcher.match(path.node)) {
            const binding = path.scope.getBinding(tmpVar.current!.name);
            if (
              iifeMatcher.match(path.parentPath.parent) &&
              isTemporaryVariable(binding, 2, 'param')
            ) {
              path.parentPath.parentPath!.replaceWith(
                t.logicalExpression('??', left.current!, right.current!),
              );
              this.changes++;
            } else if (isTemporaryVariable(binding, 2, 'var')) {
              binding.path.remove();
              path.replaceWith(
                t.logicalExpression('??', left.current!, right.current!),
              );
              this.changes++;
            }
          } else if (idLooseMatcher.match(path.node)) {
            const binding = path.scope.getBinding(tmpVar.current!.name);
            if (!isTemporaryVariable(binding, 1)) return;
            binding.path.remove();
            path.replaceWith(
              t.logicalExpression('??', left.current!, right.current!),
            );
            this.changes++;
          } else if (simpleIdMatcher.match(path.node)) {
            path.replaceWith(
              t.logicalExpression('??', left.current!, right.current!),
            );
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: transpile/transforms/optional-chaining.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
import { isTemporaryVariable } from '../../ast-utils';
export default {
  name: 'optional-chaining',
  tags: ['safe'],
  scope: true,
  visitor() {
    const object = m.capture(m.anyExpression());
    const member = m.capture(m.memberExpression(m.fromCapture(object)));
    const simpleMatcher = m.conditionalExpression(
      m.logicalExpression(
        '||',
        m.binaryExpression('===', object, m.nullLiteral()),
        m.binaryExpression(
          '===',
          m.fromCapture(object),
          m.identifier('undefined'),
        ),
      ),
      m.identifier('undefined'),
      member,
    );
    const tmpVar = m.capture(m.identifier());
    const tmpMember = m.capture(m.memberExpression(m.fromCapture(tmpVar)));
    const tmpMatcher = m.conditionalExpression(
      m.logicalExpression(
        '||',
        m.binaryExpression(
          '===',
          m.assignmentExpression('=', tmpVar, object),
          m.nullLiteral(),
        ),
        m.binaryExpression(
          '===',
          m.fromCapture(tmpVar),
          m.identifier('undefined'),
        ),
      ),
      m.identifier('undefined'),
      tmpMember,
    );
    return {
      ConditionalExpression: {
        exit(path) {
          if (simpleMatcher.match(path.node)) {
            member.current!.optional = true;
            path.replaceWith(
              t.optionalMemberExpression(
                object.current!,
                member.current!.property as t.Expression,
                member.current!.computed,
                true,
              ),
            );
            this.changes++;
          } else if (tmpMatcher.match(path.node)) {
            const binding = path.scope.getBinding(tmpVar.current!.name);
            if (!isTemporaryVariable(binding, 2)) return;
            binding.path.remove();
            tmpMember.current!.optional = true;
            path.replaceWith(
              t.optionalMemberExpression(
                object.current!,
                tmpMember.current!.property as t.Expression,
                tmpMember.current!.computed,
                true,
              ),
            );
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: transpile/transforms/template-literals.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
import { constMemberExpression } from '../../ast-utils';
function escape(str: string) {
  return (
    str
      .replaceAll('\\', '\\\\')
      .replaceAll('`', '\\`')
      .replaceAll('$', '\\$')
      .replaceAll('\0', '\\0')
      .replaceAll('\b', '\\b')
      .replaceAll('\f', '\\f')
      .replaceAll('\r', '\\r')
      .replaceAll('\t', '\\t')
      .replaceAll('\v', '\\v')
  );
}
function push(template: t.TemplateLiteral, value: t.Expression) {
  if (value.type === 'StringLiteral') {
    const lastQuasi = template.quasis.at(-1)!;
    lastQuasi.value.raw += escape(value.value);
  } else if (value.type === 'TemplateLiteral') {
    const lastQuasi = template.quasis.at(-1)!;
    const firstQuasi = value.quasis[0];
    lastQuasi.value.raw += firstQuasi.value.raw;
    template.expressions.push(...value.expressions);
    template.quasis.push(...value.quasis.slice(1));
  } else {
    template.expressions.push(value);
    template.quasis.push(t.templateElement({ raw: '' }));
  }
}
function unshift(template: t.TemplateLiteral, value: t.Expression) {
  if (value.type === 'StringLiteral') {
    const firstQuasi = template.quasis[0];
    firstQuasi.value.raw = escape(value.value) + firstQuasi.value.raw;
  } else {
    template.expressions.unshift(value);
    template.quasis.unshift(t.templateElement({ raw: '' }));
  }
}
export default {
  name: 'template-literals',
  tags: ['unsafe'],
  visitor() {
    const string = m.capture(m.or(m.stringLiteral(), m.templateLiteral()));
    const concatMatcher = m.callExpression(
      constMemberExpression(string, 'concat'),
      m.arrayOf(m.anyExpression()),
    );
    return {
      BinaryExpression: {
        exit(path) {
          if (path.node.operator !== '+') return;
          if (t.isTemplateLiteral(path.node.left)) {
            push(path.node.left, path.node.right);
            path.replaceWith(path.node.left);
            this.changes++;
          } else if (
            t.isTemplateLiteral(path.node.right) &&
            t.isExpression(path.node.left)
          ) {
            unshift(path.node.right, path.node.left);
            path.replaceWith(path.node.right);
            this.changes++;
          }
        },
      },
      CallExpression: {
        exit(path) {
          if (concatMatcher.match(path.node)) {
            const template = t.templateLiteral(
              [t.templateElement({ raw: '' })],
              [],
            );
            push(template, string.current!);
            for (const arg of path.node.arguments) {
              push(template, arg as t.Expression);
            }
            path.replaceWith(template);
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/index.ts
````typescript
import { mergeTransforms } from '../ast-utils';
import * as transforms from './transforms';
export default mergeTransforms({
  name: 'unminify',
  tags: ['safe'],
  transforms: Object.values(transforms),
});
````

## File: unminify/transforms/block-statements.ts
````typescript
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';
export default {
  name: 'block-statements',
  tags: ['safe'],
  visitor: () => ({
    IfStatement: {
      exit(path) {
        if (
          !t.isBlockStatement(path.node.consequent) &&
          !t.isEmptyStatement(path.node.consequent)
        ) {
          path.node.consequent = t.blockStatement([path.node.consequent]);
          this.changes++;
        }
        if (path.node.alternate && !t.isBlockStatement(path.node.alternate)) {
          path.node.alternate = t.blockStatement([path.node.alternate]);
          this.changes++;
        }
      },
    },
    Loop: {
      exit(path) {
        if (
          !t.isBlockStatement(path.node.body) &&
          !t.isEmptyStatement(path.node.body)
        ) {
          path.node.body = t.blockStatement([path.node.body]);
          this.changes++;
        }
      },
    },
    ArrowFunctionExpression: {
      exit(path) {
        if (t.isSequenceExpression(path.node.body)) {
          path.node.body = t.blockStatement([
            t.returnStatement(path.node.body),
          ]);
          this.changes++;
        }
      },
    },
  }),
} satisfies Transform;
````

## File: unminify/transforms/computed-properties.ts
````typescript
import { isIdentifierName } from '@babel/helper-validator-identifier';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
export default {
  name: 'computed-properties',
  tags: ['safe'],
  visitor() {
    const stringMatcher = m.capture(
      m.stringLiteral(m.matcher(isIdentifierName)),
    );
    const propertyMatcher = m.or(
      m.memberExpression(m.anything(), stringMatcher, true),
      m.optionalMemberExpression(m.anything(), stringMatcher, true),
    );
    const keyMatcher = m.or(
      m.objectProperty(stringMatcher),
      m.classProperty(stringMatcher),
      m.objectMethod(undefined, stringMatcher),
      m.classMethod(undefined, stringMatcher),
    );
    return {
      'MemberExpression|OptionalMemberExpression': {
        exit(path) {
          if (!propertyMatcher.match(path.node)) return;
          path.node.computed = false;
          path.node.property = t.identifier(stringMatcher.current!.value);
          this.changes++;
        },
      },
      'ObjectProperty|ClassProperty|ObjectMethod|ClassMethod': {
        exit(path) {
          if (!keyMatcher.match(path.node)) return;
          if (
            (path.type === 'ClassMethod' &&
              stringMatcher.current!.value === 'constructor') ||
            (path.type === 'ObjectProperty' &&
              stringMatcher.current!.value === '__proto__')
          )
            return;
          path.node.computed = false;
          path.node.key = t.identifier(stringMatcher.current!.value);
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/for-to-while.ts
````typescript
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';
export default {
  name: 'for-to-while',
  tags: ['safe'],
  visitor() {
    return {
      ForStatement: {
        exit(path) {
          const { test, body, init, update } = path.node;
          if (init || update) return;
          path.replaceWith(
            t.whileStatement(test ?? t.booleanLiteral(true), body),
          );
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/index.ts
````typescript
export { default as blockStatements } from './block-statements';
export { default as computedProperties } from './computed-properties';
export { default as forToWhile } from './for-to-while';
export { default as infinity } from './infinity';
export { default as invertBooleanLogic } from './invert-boolean-logic';
export { default as jsonParse } from './json-parse';
export { default as logicalToIf } from './logical-to-if';
export { default as mergeElseIf } from './merge-else-if';
export { default as mergeStrings } from './merge-strings';
export { default as numberExpressions } from './number-expressions';
export { default as rawLiterals } from './raw-literals';
export { default as removeDoubleNot } from './remove-double-not';
export { default as sequence } from './sequence';
export { default as splitForLoopVars } from './split-for-loop-vars';
export { default as splitVariableDeclarations } from './split-variable-declarations';
export { default as ternaryToIf } from './ternary-to-if';
export { default as truncateNumberLiteral } from './truncate-number-literal';
export { default as typeofUndefined } from './typeof-undefined';
export { default as unaryExpressions } from './unary-expressions';
export { default as unminifyBooleans } from './unminify-booleans';
export { default as voidToUndefined } from './void-to-undefined';
export { default as yoda } from './yoda';
````

## File: unminify/transforms/infinity.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
export default {
  name: 'infinity',
  tags: ['safe'],
  scope: true,
  visitor: () => {
    const infinityMatcher = m.binaryExpression(
      '/',
      m.numericLiteral(1),
      m.numericLiteral(0),
    );
    const negativeInfinityMatcher = m.binaryExpression(
      '/',
      m.unaryExpression('-', m.numericLiteral(1)),
      m.numericLiteral(0),
    );
    return {
      BinaryExpression: {
        exit(path) {
          if (path.scope.hasBinding('Infinity', { noGlobals: true })) return;
          if (infinityMatcher.match(path.node)) {
            path.replaceWith(t.identifier('Infinity'));
            this.changes++;
          } else if (negativeInfinityMatcher.match(path.node)) {
            path.replaceWith(t.unaryExpression('-', t.identifier('Infinity')));
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/invert-boolean-logic.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
const INVERTED_BINARY_OPERATORS = {
  '==': '!=',
  '===': '!==',
  '!=': '==',
  '!==': '===',
} as const;
const INVERTED_LOGICAL_OPERATORS = {
  '||': '&&',
  '&&': '||',
} as const;
export default {
  name: 'invert-boolean-logic',
  tags: ['safe'],
  visitor: () => {
    const logicalExpression = m.logicalExpression(
      m.or(...Object.values(INVERTED_LOGICAL_OPERATORS)),
    );
    const logicalMatcher = m.unaryExpression('!', logicalExpression);
    const binaryExpression = m.capture(
      m.binaryExpression(m.or(...Object.values(INVERTED_BINARY_OPERATORS))),
    );
    const binaryMatcher = m.unaryExpression('!', binaryExpression);
    return {
      UnaryExpression: {
        exit(path) {
          const { argument } = path.node;
          if (binaryMatcher.match(path.node)) {
            binaryExpression.current!.operator =
              INVERTED_BINARY_OPERATORS[
                binaryExpression.current!
                  .operator as keyof typeof INVERTED_BINARY_OPERATORS
              ];
            path.replaceWith(binaryExpression.current!);
            this.changes++;
          } else if (logicalMatcher.match(path.node)) {
            let current = argument;
            while (logicalExpression.match(current)) {
              current.operator =
                INVERTED_LOGICAL_OPERATORS[
                  current.operator as keyof typeof INVERTED_LOGICAL_OPERATORS
                ];
              current.right = t.unaryExpression('!', current.right);
              if (!logicalExpression.match(current.left)) {
                current.left = t.unaryExpression('!', current.left);
              }
              current = current.left;
            }
            path.replaceWith(argument);
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/json-parse.ts
````typescript
import { parseExpression } from '@babel/parser';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
import { constMemberExpression } from '../../ast-utils';
export default {
  name: 'json-parse',
  tags: ['safe'],
  scope: true,
  visitor: () => {
    const string = m.capture(m.anyString());
    const matcher = m.callExpression(constMemberExpression('JSON', 'parse'), [
      m.stringLiteral(string),
    ]);
    return {
      CallExpression: {
        exit(path) {
          if (
            matcher.match(path.node) &&
            !path.scope.hasBinding('JSON', { noGlobals: true })
          ) {
            try {
              JSON.parse(string.current!);
              const parsed = parseExpression(string.current!);
              path.replaceWith(parsed);
              this.changes++;
            } catch {
            }
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/logical-to-if.ts
````typescript
import { statement } from '@babel/template';
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';
export default {
  name: 'logical-to-if',
  tags: ['safe'],
  visitor: () => {
    const buildIf = statement`if (TEST) { BODY; }`;
    const buildIfNot = statement`if (!TEST) { BODY; }`;
    return {
      ExpressionStatement: {
        exit(path) {
          const expression = path.node.expression as t.LogicalExpression;
          if (!t.isLogicalExpression(expression)) return;
          if (expression.operator === '&&') {
            path.replaceWith(
              buildIf({
                TEST: expression.left,
                BODY: expression.right,
              }),
            );
            this.changes++;
          } else if (expression.operator === '||') {
            path.replaceWith(
              buildIfNot({
                TEST: expression.left,
                BODY: expression.right,
              }),
            );
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/merge-else-if.ts
````typescript
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
export default {
  name: 'merge-else-if',
  tags: ['safe'],
  visitor() {
    const nestedIf = m.capture(m.ifStatement());
    const matcher = m.ifStatement(
      m.anything(),
      m.anything(),
      m.blockStatement([nestedIf]),
    );
    return {
      IfStatement: {
        exit(path) {
          if (matcher.match(path.node)) {
            path.node.alternate = nestedIf.current;
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/merge-strings.ts
````typescript
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
export default {
  name: 'merge-strings',
  tags: ['safe'],
  visitor() {
    const left = m.capture(m.stringLiteral());
    const right = m.capture(m.stringLiteral());
    const matcher = m.binaryExpression(
      '+',
      m.or(left, m.binaryExpression('+', m.anything(), left)),
      right,
    );
    return {
      BinaryExpression: {
        exit(path) {
          if (!matcher.match(path.node)) return;
          left.current!.value += right.current!.value;
          right.current!.value = '';
          path.replaceWith(path.node.left);
          path.skip();
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/number-expressions.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
export default {
  name: 'number-expressions',
  tags: ['safe'],
  visitor: () => ({
    'BinaryExpression|UnaryExpression': {
      exit(path) {
        if (!matcher.match(path.node)) return;
        const evaluated = path.evaluate();
        if (
          t.isBinaryExpression(path.node, { operator: '/' }) &&
          !Number.isInteger(evaluated.value)
        ) {
          return;
        }
        path.replaceWith(t.valueToNode(evaluated.value));
        path.skip();
        this.changes++;
      },
    },
  }),
} satisfies Transform;
const matcher = m.or(
  m.unaryExpression('-', m.or(m.stringLiteral(), m.numericLiteral())),
  m.binaryExpression(
    m.or('+', '-', '/', '%', '*', '**', '&', '|', '>>', '>>>', '<<', '^'),
    m.or(
      m.stringLiteral(),
      m.numericLiteral(),
      m.unaryExpression('-', m.numericLiteral()),
    ),
    m.or(
      m.stringLiteral(),
      m.numericLiteral(),
      m.unaryExpression('-', m.numericLiteral()),
    ),
  ),
);
````

## File: unminify/transforms/raw-literals.ts
````typescript
import type { Transform } from '../../ast-utils';
export default {
  name: 'raw-literals',
  tags: ['safe'],
  visitor: () => ({
    StringLiteral(path) {
      if (path.node.extra) {
        path.node.extra = undefined;
        this.changes++;
      }
    },
    NumericLiteral(path) {
      if (path.node.extra) {
        path.node.extra = undefined;
        this.changes++;
      }
    },
  }),
} satisfies Transform;
````

## File: unminify/transforms/remove-double-not.ts
````typescript
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { constMemberExpression, type Transform } from '../../ast-utils';
export default {
  name: 'remove-double-not',
  tags: ['safe'],
  visitor() {
    const expression = m.capture(m.anyExpression());
    const doubleNot = m.unaryExpression(
      '!',
      m.unaryExpression('!', expression),
    );
    const tripleNot = m.unaryExpression('!', doubleNot);
    const arrayCall = m.callExpression(
      constMemberExpression(
        m.arrayExpression(),
        m.or(
          'filter',
          'find',
          'findLast',
          'findIndex',
          'findLastIndex',
          'some',
          'every',
        ),
      ),
      [m.arrowFunctionExpression(m.anything(), doubleNot)],
    );
    return {
      Conditional: {
        exit(path) {
          if (doubleNot.match(path.node.test)) {
            path.get('test').replaceWith(expression.current!);
            this.changes++;
          }
        },
      },
      UnaryExpression: {
        exit(path) {
          if (tripleNot.match(path.node)) {
            path.replaceWith(t.unaryExpression('!', expression.current!));
            this.changes++;
          }
        },
      },
      CallExpression: {
        exit(path) {
          if (arrayCall.match(path.node)) {
            (path.get('arguments.0.body') as NodePath).replaceWith(
              expression.current!,
            );
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/sequence.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { safeLiteral, type Transform } from '../../ast-utils';
export default {
  name: 'sequence',
  tags: ['safe'],
  visitor() {
    const assignmentVariable = m.or(
      m.identifier(),
      m.memberExpression(m.identifier(), m.or(m.identifier(), safeLiteral)),
    );
    const assignedSequence = m.capture(m.sequenceExpression());
    const assignmentMatcher = m.assignmentExpression(
      m.or(
        '=',
        '+=',
        '-=',
        '*=',
        '/=',
        '%=',
        '**=',
        '<<=',
        '>>=',
        '>>>=',
        '|=',
        '^=',
        '&=',
      ),
      assignmentVariable,
      assignedSequence,
    );
    return {
      AssignmentExpression: {
        exit(path) {
          if (!assignmentMatcher.match(path.node)) return;
          const { expressions } = assignedSequence.current!;
          path.node.right = expressions.pop()!;
          const newNodes = path.parentPath.isExpressionStatement()
            ? expressions.map(t.expressionStatement)
            : expressions;
          path.insertBefore(newNodes);
          this.changes++;
        },
      },
      ExpressionStatement: {
        exit(path) {
          if (!t.isSequenceExpression(path.node.expression)) return;
          const statements = path.node.expression.expressions.map(
            t.expressionStatement,
          );
          path.replaceWithMultiple(statements);
          this.changes++;
        },
      },
      ReturnStatement: {
        exit(path) {
          if (!t.isSequenceExpression(path.node.argument)) return;
          const { expressions } = path.node.argument;
          path.node.argument = expressions.pop();
          const statements = expressions.map(t.expressionStatement);
          path.insertBefore(statements);
          this.changes++;
        },
      },
      IfStatement: {
        exit(path) {
          if (!t.isSequenceExpression(path.node.test)) return;
          const { expressions } = path.node.test;
          path.node.test = expressions.pop()!;
          const statements = expressions.map(t.expressionStatement);
          path.insertBefore(statements);
          this.changes++;
        },
      },
      SwitchStatement: {
        exit(path) {
          if (!t.isSequenceExpression(path.node.discriminant)) return;
          const { expressions } = path.node.discriminant;
          path.node.discriminant = expressions.pop()!;
          const statements = expressions.map(t.expressionStatement);
          path.insertBefore(statements);
          this.changes++;
        },
      },
      ThrowStatement: {
        exit(path) {
          if (!t.isSequenceExpression(path.node.argument)) return;
          const { expressions } = path.node.argument;
          path.node.argument = expressions.pop()!;
          const statements = expressions.map(t.expressionStatement);
          path.insertBefore(statements);
          this.changes++;
        },
      },
      ForInStatement: {
        exit(path) {
          if (!t.isSequenceExpression(path.node.right)) return;
          const { expressions } = path.node.right;
          path.node.right = expressions.pop()!;
          const statements = expressions.map(t.expressionStatement);
          path.insertBefore(statements);
          this.changes++;
        },
      },
      ForOfStatement: {
        exit(path) {
          if (!t.isSequenceExpression(path.node.right)) return;
          const { expressions } = path.node.right;
          path.node.right = expressions.pop()!;
          const statements = expressions.map(t.expressionStatement);
          path.insertBefore(statements);
          this.changes++;
        },
      },
      ForStatement: {
        exit(path) {
          if (t.isSequenceExpression(path.node.init)) {
            const statements = path.node.init.expressions.map(
              t.expressionStatement,
            );
            path.node.init = null;
            path.insertBefore(statements);
            this.changes++;
          }
          if (
            t.isSequenceExpression(path.node.update) &&
            path.node.body.type === 'EmptyStatement'
          ) {
            const { expressions } = path.node.update;
            path.node.update = expressions.pop()!;
            const statements = expressions.map(t.expressionStatement);
            path.node.body = t.blockStatement(statements);
            this.changes++;
          }
        },
      },
      VariableDeclaration: {
        exit(path) {
          const sequence = m.capture(m.sequenceExpression());
          const matcher = m.variableDeclaration(undefined, [
            m.variableDeclarator(undefined, sequence),
          ]);
          if (!matcher.match(path.node)) return;
          const { expressions } = sequence.current!;
          path.node.declarations[0].init = expressions.pop();
          const statements = expressions.map(t.expressionStatement);
          path.getStatementParent()?.insertBefore(statements);
          this.changes++;
        },
      },
      SequenceExpression: {
        exit(path) {
          const { expressions } = path.node;
          if (expressions.every((node) => safeLiteral.match(node))) {
            path.replaceWith(expressions.at(-1)!);
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/split-for-loop-vars.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
const matcher = m.forStatement(
  m.variableDeclaration('var', m.arrayOf(m.variableDeclarator(m.identifier()))),
);
export default {
  name: 'split-for-loop-vars',
  tags: ['safe'],
  scope: true,
  visitor: () => ({
    ForStatement: {
      exit(path) {
        if (!matcher.match(path.node)) return;
        const { init, test, update } = path.node;
        const { declarations } = init as t.VariableDeclaration;
        for (let i = 0; i < declarations.length; i++) {
          const declarator = declarations[i];
          const binding = path.scope.getBinding(
            (declarator.id as t.Identifier).name,
          );
          if (!binding) break;
          const isUsedInTestOrUpdate =
            binding.constantViolations.some((reference) =>
              reference.find((p) => p.node === test || p.node === update),
            ) ||
            binding.referencePaths.some((reference) =>
              reference.find((p) => p.node === test || p.node === update),
            );
          if (isUsedInTestOrUpdate) break;
          path.insertBefore(t.variableDeclaration('var', [declarator]));
          declarations.shift();
          i--;
          this.changes++;
        }
        if (declarations.length === 0) path.get('init').remove();
      },
    },
  }),
} satisfies Transform;
````

## File: unminify/transforms/split-variable-declarations.ts
````typescript
import * as t from '@babel/types';
import type { Transform } from '../../ast-utils';
export default {
  name: 'split-variable-declarations',
  tags: ['safe'],
  visitor: () => ({
    VariableDeclaration: {
      exit(path) {
        if (path.node.declarations.length > 1) {
          if (path.key === 'init' && path.parentPath.isForStatement()) {
            if (
              !path.parentPath.node.test &&
              !path.parentPath.node.update &&
              path.node.kind === 'var'
            ) {
              path.parentPath.insertBefore(
                path.node.declarations.map((declaration) =>
                  t.variableDeclaration(path.node.kind, [declaration]),
                ),
              );
              path.remove();
              this.changes++;
            }
          } else {
            if (path.parentPath.isExportNamedDeclaration()) {
              path.parentPath.replaceWithMultiple(
                path.node.declarations.map((declaration) =>
                  t.exportNamedDeclaration(
                    t.variableDeclaration(path.node.kind, [declaration]),
                  ),
                ),
              );
            } else {
              path.replaceWithMultiple(
                path.node.declarations.map((declaration) =>
                  t.variableDeclaration(path.node.kind, [declaration]),
                ),
              );
            }
            this.changes++;
          }
        }
      },
    },
  }),
} satisfies Transform;
````

## File: unminify/transforms/ternary-to-if.ts
````typescript
import { statement } from '@babel/template';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
export default {
  name: 'ternary-to-if',
  tags: ['safe'],
  visitor() {
    const test = m.capture(m.anyExpression());
    const consequent = m.capture(m.anyExpression());
    const alternate = m.capture(m.anyExpression());
    const conditional = m.conditionalExpression(test, consequent, alternate);
    const buildIf = statement`if (TEST) { CONSEQUENT; } else { ALTERNATE; }`;
    const buildIfReturn = statement`if (TEST) { return CONSEQUENT; } else { return ALTERNATE; }`;
    return {
      ExpressionStatement: {
        exit(path) {
          if (conditional.match(path.node.expression)) {
            path.replaceWith(
              buildIf({
                TEST: test.current,
                CONSEQUENT: consequent.current,
                ALTERNATE: alternate.current,
              }),
            );
            this.changes++;
          }
        },
      },
      ReturnStatement: {
        exit(path) {
          if (conditional.match(path.node.argument)) {
            path.replaceWith(
              buildIfReturn({
                TEST: test.current,
                CONSEQUENT: consequent.current,
                ALTERNATE: alternate.current,
              }),
            );
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/truncate-number-literal.ts
````typescript
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
export default {
  name: 'truncate-number-literal',
  tags: ['safe'],
  visitor: () => {
    const binaryOperators = m.or('|', '&', '^', '<<', '>>', '>>>');
    const literal = m.capture(m.numericLiteral());
    const matcher = m.or(
      m.binaryExpression(binaryOperators, literal, m.anything()),
      m.binaryExpression(binaryOperators, m.anything(), literal),
    );
    return {
      BinaryExpression: {
        exit(path) {
          if (!matcher.match(path.node)) return;
          const value = literal.current!.value;
          const isShifter =
            literal.current! === path.node.right &&
            (path.node.operator === '<<' || path.node.operator === '>>');
          const truncation = isShifter ? 31 : 0xffffffff;
          const truncated = value & truncation;
          if (truncated === value) return;
          literal.current!.value = truncated;
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/typeof-undefined.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
const OPERATOR_MAP = {
  '>': '===',
  '<': '!==',
} as const;
export default {
  name: 'typeof-undefined',
  tags: ['safe'],
  visitor() {
    const operator = m.capture(m.or('>' as const, '<' as const));
    const argument = m.capture(m.anyExpression());
    const matcher = m.binaryExpression(
      operator,
      m.unaryExpression('typeof', argument),
      m.stringLiteral('u'),
    );
    return {
      BinaryExpression: {
        exit(path) {
          if (!matcher.match(path.node)) return;
          path.replaceWith(
            t.binaryExpression(
              OPERATOR_MAP[operator.current!],
              t.unaryExpression('typeof', argument.current!),
              t.stringLiteral('undefined'),
            ),
          );
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/unary-expressions.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
export default {
  name: 'unary-expressions',
  tags: ['safe'],
  visitor() {
    const argument = m.capture(m.anyExpression());
    const matcher = m.expressionStatement(
      m.unaryExpression(m.or('void', '!', 'typeof'), argument),
    );
    const returnVoid = m.returnStatement(m.unaryExpression('void', argument));
    return {
      ExpressionStatement: {
        exit(path) {
          if (!matcher.match(path.node)) return;
          path.replaceWith(argument.current!);
          this.changes++;
        },
      },
      ReturnStatement: {
        exit(path) {
          if (!returnVoid.match(path.node)) return;
          path.replaceWith(argument.current!);
          path.insertAfter(t.returnStatement());
          this.changes++;
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/unminify-booleans.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
export default {
  name: 'unminify-booleans',
  tags: ['safe'],
  visitor: () => ({
    UnaryExpression(path) {
      if (trueMatcher.match(path.node)) {
        path.replaceWith(t.booleanLiteral(true));
        this.changes++;
      } else if (falseMatcher.match(path.node)) {
        path.replaceWith(t.booleanLiteral(false));
        this.changes++;
      }
    },
  }),
} satisfies Transform;
const trueMatcher = m.or(
  m.unaryExpression('!', m.numericLiteral(0)),
  m.unaryExpression('!', m.unaryExpression('!', m.numericLiteral(1))),
  m.unaryExpression('!', m.unaryExpression('!', m.arrayExpression([]))),
);
const falseMatcher = m.or(
  m.unaryExpression('!', m.numericLiteral(1)),
  m.unaryExpression('!', m.arrayExpression([])),
);
````

## File: unminify/transforms/void-to-undefined.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
export default {
  name: 'void-to-undefined',
  tags: ['safe'],
  scope: true,
  visitor: () => {
    const matcher = m.unaryExpression('void', m.numericLiteral(0));
    return {
      UnaryExpression: {
        exit(path) {
          if (
            matcher.match(path.node) &&
            !path.scope.hasBinding('undefined', { noGlobals: true })
          ) {
            path.replaceWith(t.identifier('undefined'));
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unminify/transforms/yoda.ts
````typescript
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
const FLIPPED_OPERATORS = {
  '==': '==',
  '===': '===',
  '!=': '!=',
  '!==': '!==',
  '>': '<',
  '<': '>',
  '>=': '<=',
  '<=': '>=',
  '*': '*',
  '^': '^',
  '&': '&',
  '|': '|',
} as const;
export default {
  name: 'yoda',
  tags: ['safe'],
  visitor: () => {
    const pureValue = m.or(
      m.stringLiteral(),
      m.numericLiteral(),
      m.unaryExpression(
        '-',
        m.or(m.numericLiteral(), m.identifier('Infinity')),
      ),
      m.booleanLiteral(),
      m.nullLiteral(),
      m.identifier('undefined'),
      m.identifier('NaN'),
      m.identifier('Infinity'),
    );
    const matcher = m.binaryExpression(
      m.or(...Object.values(FLIPPED_OPERATORS)),
      pureValue,
      m.matcher((node) => !pureValue.match(node)),
    );
    return {
      BinaryExpression: {
        exit(path) {
          if (matcher.match(path.node)) {
            path.replaceWith(
              t.binaryExpression(
                FLIPPED_OPERATORS[
                  path.node.operator as keyof typeof FLIPPED_OPERATORS
                ],
                path.node.right,
                path.node.left as t.Expression,
              ),
            );
            this.changes++;
          }
        },
      },
    };
  },
} satisfies Transform;
````

## File: unpack/browserify/bundle.ts
````typescript
import { Bundle } from '../bundle';
import type { BrowserifyModule } from './module';
export class BrowserifyBundle extends Bundle {
  constructor(entryId: string, modules: Map<string, BrowserifyModule>) {
    super('browserify', entryId, modules);
  }
}
````

## File: unpack/browserify/index.ts
````typescript
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Transform } from '../../ast-utils';
import { constKey, getPropName, iife, renameParameters } from '../../ast-utils';
import type { Bundle } from '../bundle';
import { resolveDependencyTree } from '../path';
import { BrowserifyBundle } from './bundle';
import { BrowserifyModule } from './module';
export const unpackBrowserify = {
  name: 'unpack-browserify',
  tags: ['unsafe'],
  scope: true,
  visitor(options) {
    const modules = new Map<string, BrowserifyModule>();
    const files = m.capture(
      m.arrayOf(
        m.objectProperty(
          m.or(m.numericLiteral(), m.stringLiteral(), m.identifier()),
          m.arrayExpression([
            m.functionExpression(),
            m.objectExpression(
              m.arrayOf(
                m.objectProperty(
                  constKey(),
                  m.or(
                    m.numericLiteral(),
                    m.identifier('undefined'),
                    m.stringLiteral(),
                  ),
                ),
              ),
            ),
          ]),
        ),
      ),
    );
    const entryIdMatcher = m.capture(
      m.or(m.numericLiteral(), m.stringLiteral()),
    );
    const matcher = m.callExpression(
      m.or(
        m.functionExpression(undefined, [
          m.identifier(),
          m.identifier(),
          m.identifier(),
        ]),
        iife(
          [],
          m.blockStatement([
            m.functionDeclaration(undefined, [
              m.identifier(),
              m.identifier(),
              m.identifier(),
            ]),
            m.returnStatement(m.identifier()),
          ]),
        ),
      ),
      [
        m.objectExpression(files),
        m.objectExpression(),
        m.arrayExpression(m.anyList(entryIdMatcher, m.zeroOrMore())),
      ],
    );
    return {
      CallExpression(path) {
        if (!matcher.match(path.node)) return;
        path.stop();
        const entryId = entryIdMatcher.current!.value.toString();
        const modulesPath = path.get(
          files.currentKeys!.join('.'),
        ) as NodePath<t.ObjectProperty>[];
        const dependencyTree: Record<string, Record<string, string>> = {};
        for (const moduleWrapper of modulesPath) {
          const id = getPropName(moduleWrapper.node.key)!;
          const fn = moduleWrapper.get(
            'value.elements.0',
          ) as NodePath<t.FunctionExpression>;
          const dependencies: Record<string, string> = (dependencyTree[id] =
            {});
          const dependencyProperties = (
            moduleWrapper.get(
              'value.elements.1',
            ) as NodePath<t.ObjectExpression>
          ).node.properties as t.ObjectProperty[];
          for (const dependency of dependencyProperties) {
            if (
              dependency.value.type !== 'NumericLiteral' &&
              dependency.value.type !== 'StringLiteral'
            )
              continue;
            const filePath = getPropName(dependency.key)!;
            const depId = dependency.value.value.toString();
            dependencies[depId] = filePath;
          }
          renameParameters(fn, ['require', 'module', 'exports']);
          const file = t.file(t.program(fn.node.body.body));
          const module = new BrowserifyModule(
            id,
            file,
            id === entryId,
            dependencies,
          );
          modules.set(id.toString(), module);
        }
        const resolvedPaths = resolveDependencyTree(dependencyTree, entryId);
        for (const module of modules.values()) {
          if (Object.hasOwn(resolvedPaths, module.id)) {
            module.path = resolvedPaths[module.id];
          }
        }
        if (modules.size > 0) {
          options!.bundle = new BrowserifyBundle(entryId, modules);
        }
      },
    };
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;
````

## File: unpack/browserify/module.ts
````typescript
import type * as t from '@babel/types';
import { Module } from '../module';
export class BrowserifyModule extends Module {
  dependencies: Record<number, string>;
  constructor(
    id: string,
    ast: t.File,
    isEntry: boolean,
    dependencies: Record<number, string>,
  ) {
    super(id, ast, isEntry);
    this.dependencies = dependencies;
  }
}
````

## File: unpack/bundle.ts
````typescript
import traverse from '@babel/traverse';
import type * as m from '@codemod/matchers';
import { dirname, join, normalize, relative } from 'node:path';
import type { Module } from './module';
export class Bundle {
  type: 'webpack' | 'browserify';
  entryId: string;
  modules: Map<string, Module>;
  constructor(
    type: 'webpack' | 'browserify',
    entryId: string,
    modules: Map<string, Module>,
  ) {
    this.type = type;
    this.entryId = entryId;
    this.modules = modules;
  }
  applyMappings(mappings: Record<string, m.Matcher<unknown>>): void {
    const mappingPaths = Object.keys(mappings);
    if (mappingPaths.length === 0) return;
    const unusedMappings = new Set(mappingPaths);
    for (const module of this.modules.values()) {
      traverse(module.ast, {
        enter(path) {
          for (const mappingPath of mappingPaths) {
            if (mappings[mappingPath].match(path.node)) {
              if (unusedMappings.has(mappingPath)) {
                unusedMappings.delete(mappingPath);
              } else {
                throw new Error(`Mapping ${mappingPath} is already used.`);
              }
              const resolvedPath = mappingPath.startsWith('./')
                ? mappingPath
                : `node_modules/${mappingPath}`;
              module.path = resolvedPath;
              path.stop();
              break;
            }
          }
        },
        noScope: true,
      });
    }
  }
  async save(path: string): Promise<void> {
    const bundleJson = {
      type: this.type,
      entryId: this.entryId,
      modules: Array.from(this.modules.values(), (module) => ({
        id: module.id,
        path: module.path,
      })),
    };
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, 'bundle.json'),
      JSON.stringify(bundleJson, null, 2),
      'utf8',
    );
    await Promise.all(
      Array.from(this.modules.values(), async (module) => {
        const modulePath = normalize(join(path, module.path));
        if (relative(path, modulePath).startsWith('..')) {
          throw new Error(`detected path traversal: ${module.path}`);
        }
        await mkdir(dirname(modulePath), { recursive: true });
        await writeFile(modulePath, module.code, 'utf8');
      }),
    );
  }
  applyTransforms(): void {}
}
````

## File: unpack/index.ts
````typescript
import traverse, { visitors } from '@babel/traverse';
import type * as t from '@babel/types';
import type * as m from '@codemod/matchers';
import debug from 'debug';
import { unpackBrowserify } from './browserify';
import type { Bundle } from './bundle';
import unpackWebpack4 from './webpack/unpack-webpack-4.js';
import unpackWebpack5 from './webpack/unpack-webpack-5.js';
import unpackWebpackChunk from './webpack/unpack-webpack-chunk.js';
export { Bundle } from './bundle';
export function unpackAST(
  ast: t.Node,
  mappings: Record<string, m.Matcher<unknown>> = {},
): Bundle | undefined {
  const options: { bundle: Bundle | undefined } = { bundle: undefined };
  const visitor = visitors.merge([
    unpackWebpack4.visitor(options),
    unpackWebpack5.visitor(options),
    unpackWebpackChunk.visitor(options),
    unpackBrowserify.visitor(options),
  ]);
  traverse(ast, visitor, undefined, { changes: 0 });
  if (options.bundle) {
    options.bundle.applyMappings(mappings);
    options.bundle.applyTransforms();
    debug('webcrack:unpack')(
      `Bundle: ${options.bundle.type}, modules: ${options.bundle.modules.size}, entry id: ${options.bundle.entryId}`,
    );
  }
  return options.bundle;
}
````

## File: unpack/module.ts
````typescript
import type * as t from '@babel/types';
import { generate } from '../ast-utils';
export class Module {
  id: string;
  isEntry: boolean;
  path: string;
  ast: t.File;
  #code: string | undefined;
  constructor(id: string, ast: t.File, isEntry: boolean) {
    this.id = id;
    this.ast = ast;
    this.isEntry = isEntry;
    this.path = `./${isEntry ? 'index' : id.replace(/\.js$/, '')}.js`;
  }
  regenerateCode(): string {
    this.#code = generate(this.ast);
    return this.#code;
  }
  get code(): string {
    return this.#code ?? this.regenerateCode();
  }
  set code(code: string) {
    this.#code = code;
  }
}
````

## File: unpack/path.ts
````typescript
import { posix } from 'node:path';
const { dirname, join, relative } = posix;
export function relativePath(from: string, to: string): string {
  if (to.startsWith('node_modules/')) return to.replace('node_modules/', '');
  const relativePath = relative(dirname(from), to);
  return relativePath.startsWith('.') ? relativePath : './' + relativePath;
}
/**
 * Resolve the path of each module of a browserify bundle
 * based on its dependencies.
 * @param tree module id -> dependencies (id -> path)
 * @param entry entry module id
 */
export function resolveDependencyTree(
  tree: Record<string, Record<string, string>>,
  entry: string,
): Record<string, string> {
  const paths = resolveTreePaths(tree, entry);
  paths[entry] = './index.js';
  const entryDepth = Object.values(paths).reduce(
    (acc, path) => Math.max(acc, path.split('..').length),
    0,
  );
  const prefix = Array(entryDepth - 1)
    .fill(0)
    .map((_, i) => `tmp${i}`)
    .join('/');
  return Object.fromEntries(
    Object.entries(paths).map(([id, path]) => {
      const newPath = path.startsWith('node_modules/')
        ? path
        : join(prefix, path);
      return [id, newPath];
    }),
  );
}
function resolveTreePaths(
  graph: Record<string, Record<string, string>>,
  entry: string,
  cwd = '.',
  paths: Record<string, string> = {},
) {
  const entries = Object.entries(graph[entry]);
  for (const [id, name] of entries) {
    const isCircular = Object.hasOwn(paths, id);
    if (isCircular) continue;
    let path: string;
    if (name.startsWith('.')) {
      path = join(cwd, name);
      if (!path.endsWith('.js')) path += '.js';
    } else {
      path = join('node_modules', name, 'index.js');
    }
    paths[id] = path;
    const newCwd = path.endsWith('.js') ? dirname(path) : path;
    resolveTreePaths(graph, id, newCwd, paths);
  }
  return paths;
}
````

## File: unpack/webpack/bundle.ts
````typescript
import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { Bundle } from '../bundle';
import { relativePath } from '../path';
import { convertESM } from './esm';
import { convertDefaultRequire } from './getDefaultExport';
import type { WebpackModule } from './module';
import { inlineVarInjections } from './varInjection';
export class WebpackBundle extends Bundle {
  constructor(entryId: string, modules: Map<string, WebpackModule>) {
    super('webpack', entryId, modules);
  }
  applyTransforms(): void {
    this.modules.forEach(inlineVarInjections);
    this.modules.forEach(convertESM);
    convertDefaultRequire(this);
    this.replaceRequirePaths();
  }
  private replaceRequirePaths() {
    const requireId = m.capture(m.or(m.numericLiteral(), m.stringLiteral()));
    const requireMatcher = m.or(
      m.callExpression(m.identifier('require'), [requireId]),
    );
    const importId = m.capture(m.stringLiteral());
    const importMatcher = m.importDeclaration(m.anything(), importId);
    this.modules.forEach((module) => {
      traverse(module.ast, {
        'CallExpression|ImportDeclaration': (path) => {
          let moduleId: string;
          let arg: NodePath;
          if (requireMatcher.match(path.node)) {
            moduleId = requireId.current!.value.toString();
            [arg] = path.get('arguments') as NodePath<t.Identifier>[];
          } else if (importMatcher.match(path.node)) {
            moduleId = importId.current!.value;
            arg = path.get('source') as NodePath;
          } else {
            return;
          }
          const requiredModule = this.modules.get(moduleId);
          arg.replaceWith(
            t.stringLiteral(
              relativePath(
                module.path,
                requiredModule?.path ?? `./${moduleId}.js`,
              ),
            ),
          );
          if (!requiredModule) {
            arg.addComment('leading', 'webcrack:missing');
          }
        },
        noScope: true,
      });
    });
  }
}
````

## File: unpack/webpack/common-matchers.ts
````typescript
import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import {
  anonymousFunction,
  anySubList,
  constMemberExpression,
  getPropName,
} from '../../ast-utils';
export type FunctionPath = NodePath<
  | t.FunctionExpression
  | (t.ArrowFunctionExpression & { body: t.BlockStatement })
>;
export function webpackRequireFunctionMatcher() {
  const containerId = m.capture(m.identifier());
  const webpackRequire = m.capture(
    m.functionDeclaration(
      m.identifier(),
      [m.identifier()],
      m.blockStatement(
        anySubList(
          m.expressionStatement(
            m.callExpression(
              m.or(
                constMemberExpression(
                  m.memberExpression(
                    m.fromCapture(containerId),
                    m.identifier(),
                    true,
                  ),
                  'call',
                ),
                m.memberExpression(
                  m.fromCapture(containerId),
                  m.identifier(),
                  true,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return { webpackRequire, containerId };
}
export function modulesContainerMatcher(): m.CapturedMatcher<
  t.ArrayExpression | t.ObjectExpression
> {
  return m.capture(
    m.or(
      m.arrayExpression(m.arrayOf(m.or(anonymousFunction(), null))),
      m.objectExpression(
        m.arrayOf(
          m.or(
            m.objectProperty(
              m.or(m.numericLiteral(), m.stringLiteral(), m.identifier()),
              anonymousFunction(),
            ),
            m.objectProperty(m.identifier('c'), m.stringLiteral()),
          ),
        ),
      ),
    ),
  );
}
export function getModuleFunctions(
  container: NodePath<t.ArrayExpression | t.ObjectExpression>,
): Map<string, FunctionPath> {
  const functions = new Map<string, FunctionPath>();
  if (t.isArrayExpression(container.node)) {
    container.node.elements.forEach((element, index) => {
      if (element !== null) {
        functions.set(
          index.toString(),
          container.get(`elements.${index}`) as FunctionPath,
        );
      }
    });
  } else {
    (container.node.properties as t.ObjectProperty[]).forEach(
      (property, index) => {
        const key = getPropName(property.key)!;
        if (anonymousFunction().match(property.value)) {
          functions.set(
            key,
            container.get(`properties.${index}.value`) as FunctionPath,
          );
        }
      },
    );
  }
  return functions;
}
export function findAssignedEntryId(webpackRequireBinding: Binding) {
  const entryId = m.capture(m.or(m.numericLiteral(), m.stringLiteral()));
  const assignment = m.assignmentExpression(
    '=',
    constMemberExpression(webpackRequireBinding.identifier.name, 's'),
    entryId,
  );
  for (const reference of webpackRequireBinding.referencePaths) {
    if (assignment.match(reference.parentPath?.parent)) {
      return String(entryId.current!.value);
    }
  }
}
export function findRequiredEntryId(webpackRequireBinding: Binding) {
  const entryId = m.capture(m.or(m.numericLiteral(), m.stringLiteral()));
  const call = m.callExpression(
    m.identifier(webpackRequireBinding.identifier.name),
    [entryId],
  );
  for (const reference of webpackRequireBinding.referencePaths) {
    if (call.match(reference.parent)) {
      return String(entryId.current!.value);
    }
  }
}
````

## File: unpack/webpack/esm.ts
````typescript
import { statement } from '@babel/template';
import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import { constMemberExpression, findPath, renameFast } from '../../ast-utils';
import type { WebpackModule } from './module';
const buildNamespaceImport = statement`import * as NAME from "PATH";`;
const buildNamedExportLet = statement`export let NAME = VALUE;`;
/**
 * ```js
 * require.r(exports);
 * require.d(exports, 'counter', function () {
 *   return f;
 * });
 * let f = 1;
 * ```
 * ->
 * ```js
 * export let counter = 1;
 * ```
 */
export function convertESM(module: WebpackModule): void {
  // E.g. require.r(exports);
  const defineEsModuleMatcher = m.expressionStatement(
    m.callExpression(constMemberExpression('require', 'r'), [m.identifier()]),
  );
  const exportsName = m.capture(m.identifier());
  const exportedName = m.capture(m.anyString());
  const returnedValue = m.capture(m.anyExpression());
  // E.g. require.d(exports, "counter", function () { return f });
  const defineExportMatcher = m.expressionStatement(
    m.callExpression(constMemberExpression('require', 'd'), [
      exportsName,
      m.stringLiteral(exportedName),
      m.functionExpression(
        undefined,
        [],
        m.blockStatement([m.returnStatement(returnedValue)]),
      ),
    ]),
  );
  const emptyObjectVarMatcher = m.variableDeclarator(
    m.fromCapture(exportsName),
    m.objectExpression([]),
  );
  const properties = m.capture(
    m.arrayOf(
      m.objectProperty(
        m.identifier(),
        m.arrowFunctionExpression([], m.anyExpression()),
      ),
    ),
  );
  // E.g. require.d(exports, { foo: () => a, bar: () => b });
  const defineExportsMatcher = m.expressionStatement(
    m.callExpression(constMemberExpression('require', 'd'), [
      exportsName,
      m.objectExpression(properties),
    ]),
  );
  // E.g. const lib = require("./lib.js");
  const requireVariable = m.capture(m.identifier());
  const requiredModuleId = m.capture(m.anyNumber());
  const requireMatcher = m.variableDeclaration(undefined, [
    m.variableDeclarator(
      requireVariable,
      m.callExpression(m.identifier('require'), [
        m.numericLiteral(requiredModuleId),
      ]),
    ),
  ]);
  // module = require.hmd(module);
  const hmdMatcher = m.expressionStatement(
    m.assignmentExpression(
      '=',
      m.identifier('module'),
      m.callExpression(constMemberExpression('require', 'hmd')),
    ),
  );
  traverse(module.ast, {
    enter(path) {
      // Only traverse the top-level
      if (path.parentPath?.parentPath) return path.skip();
      if (defineEsModuleMatcher.match(path.node)) {
        module.ast.program.sourceType = 'module';
        path.remove();
      } else if (
        module.ast.program.sourceType === 'module' &&
        requireMatcher.match(path.node)
      ) {
        path.replaceWith(
          buildNamespaceImport({
            NAME: requireVariable.current,
            PATH: String(requiredModuleId.current),
          }),
        );
      } else if (defineExportsMatcher.match(path.node)) {
        const exportsBinding = path.scope.getBinding(exportsName.current!.name);
        const emptyObject = emptyObjectVarMatcher.match(
          exportsBinding?.path.node,
        )
          ? (exportsBinding?.path.node.init as t.ObjectExpression)
          : null;
        for (const property of properties.current!) {
          const exportedKey = property.key as t.Identifier;
          const returnedValue = (property.value as t.ArrowFunctionExpression)
            .body as t.Expression;
          if (emptyObject) {
            emptyObject.properties.push(
              t.objectProperty(exportedKey, returnedValue),
            );
          } else {
            exportVariable(path, returnedValue, exportedKey.name);
          }
        }
        path.remove();
      } else if (defineExportMatcher.match(path.node)) {
        exportVariable(path, returnedValue.current!, exportedName.current!);
        path.remove();
      } else if (hmdMatcher.match(path.node)) {
        path.remove();
      }
    },
  });
}
function exportVariable(
  requireDPath: NodePath,
  value: t.Expression,
  exportName: string,
) {
  if (value.type === 'Identifier') {
    const binding = requireDPath.scope.getBinding(value.name);
    if (!binding) return;
    const declaration = findPath(
      binding.path,
      m.or(
        m.variableDeclaration(),
        m.classDeclaration(),
        m.functionDeclaration(),
      ),
    );
    if (!declaration) return;
    if (exportName === 'default') {
      // `let f = 1;` -> `export default 1;`
      declaration.replaceWith(
        t.exportDefaultDeclaration(
          t.isVariableDeclaration(declaration.node)
            ? declaration.node.declarations[0].init!
            : declaration.node,
        ),
      );
    } else {
      // `let f = 1;` -> `export let counter = 1;`
      renameFast(binding, exportName);
      declaration.replaceWith(t.exportNamedDeclaration(declaration.node));
    }
  } else if (exportName === 'default') {
    requireDPath.insertAfter(t.exportDefaultDeclaration(value));
  } else {
    requireDPath.insertAfter(
      buildNamedExportLet({ NAME: t.identifier(exportName), VALUE: value }),
    );
  }
}
````

## File: unpack/webpack/getDefaultExport.ts
````typescript
import { expression } from '@babel/template';
import type { NodePath } from '@babel/traverse';
import traverse from '@babel/traverse';
import * as m from '@codemod/matchers';
import { constMemberExpression } from '../../ast-utils';
import type { WebpackBundle } from './bundle';
export function convertDefaultRequire(bundle: WebpackBundle): void {
  function getRequiredModule(path: NodePath) {
    const binding = path.scope.getBinding(moduleArg.current!.name);
    const declarator = binding?.path.node;
    if (declaratorMatcher.match(declarator)) {
      return bundle.modules.get(requiredModuleId.current!.value.toString());
    }
  }
  const requiredModuleId = m.capture(m.numericLiteral());
  const declaratorMatcher = m.variableDeclarator(
    m.identifier(),
    m.callExpression(m.identifier('require'), [requiredModuleId]),
  );
  const moduleArg = m.capture(m.identifier());
  const getterVarName = m.capture(m.identifier());
  const requireN = m.callExpression(constMemberExpression('require', 'n'), [
    moduleArg,
  ]);
  const defaultRequireMatcher = m.variableDeclarator(getterVarName, requireN);
  const defaultRequireMatcherAlternative = m.or(
    constMemberExpression(requireN, 'a'),
    m.callExpression(requireN, []),
  );
  const buildDefaultAccess = expression`OBJECT.default`;
  bundle.modules.forEach((module) => {
    traverse(module.ast, {
      'CallExpression|MemberExpression'(path) {
        if (defaultRequireMatcherAlternative.match(path.node)) {
          const requiredModule = getRequiredModule(path);
          if (requiredModule?.ast.program.sourceType === 'module') {
            path.replaceWith(
              buildDefaultAccess({ OBJECT: moduleArg.current! }),
            );
          } else {
            path.replaceWith(moduleArg.current!);
          }
        }
      },
      VariableDeclarator(path) {
        if (defaultRequireMatcher.match(path.node)) {
          const requiredModule = getRequiredModule(path);
          const init = path.get('init');
          if (requiredModule?.ast.program.sourceType === 'module') {
            init.replaceWith(
              buildDefaultAccess({ OBJECT: moduleArg.current! }),
            );
          } else {
            init.replaceWith(moduleArg.current!);
          }
          const binding = path.scope.getOwnBinding(getterVarName.current!.name);
          binding?.referencePaths.forEach((refPath) => {
            if (
              refPath.parentPath?.isCallExpression() ||
              refPath.parentPath?.isMemberExpression()
            ) {
              refPath.parentPath.replaceWith(refPath);
            }
          });
        }
      },
      noScope: true,
    });
  });
}
````

## File: unpack/webpack/module.ts
````typescript
import { Module } from '../module';
export class WebpackModule extends Module {}
````

## File: unpack/webpack/unpack-webpack-4.ts
````typescript
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Bundle } from '..';
import type { Transform } from '../../ast-utils';
import { anySubList, renameParameters } from '../../ast-utils';
import { WebpackBundle } from './bundle';
import {
  findAssignedEntryId,
  findRequiredEntryId,
  getModuleFunctions,
  modulesContainerMatcher,
  webpackRequireFunctionMatcher,
} from './common-matchers';
import { WebpackModule } from './module';
export default {
  name: 'unpack-webpack-4',
  tags: ['unsafe'],
  scope: true,
  visitor(options = { bundle: undefined }) {
    const { webpackRequire, containerId } = webpackRequireFunctionMatcher();
    const container = modulesContainerMatcher();
    const matcher = m.callExpression(
      m.functionExpression(
        null,
        [containerId],
        m.blockStatement(anySubList(webpackRequire)),
      ),
      [container],
    );
    return {
      CallExpression(path) {
        if (!matcher.match(path.node)) return;
        path.stop();
        const webpackRequireBinding = path
          .get('callee')
          .scope.getBinding(webpackRequire.current!.id!.name)!;
        const entryId =
          findAssignedEntryId(webpackRequireBinding) ||
          findRequiredEntryId(webpackRequireBinding);
        const containerPath = path.get(
          container.currentKeys!.join('.'),
        ) as NodePath<t.ArrayExpression | t.ObjectExpression>;
        const modules = new Map<string, WebpackModule>();
        for (const [id, func] of getModuleFunctions(containerPath)) {
          renameParameters(func, ['module', 'exports', 'require']);
          const isEntry = id === entryId;
          const file = t.file(t.program(func.node.body.body));
          const lastNode = file.program.body.at(-1);
          if (
            lastNode?.trailingComments?.length === 1 &&
            lastNode.trailingComments[0].value === '*'
          ) {
            lastNode.trailingComments = null;
          }
          modules.set(id, new WebpackModule(id, file, isEntry));
        }
        options.bundle = new WebpackBundle(entryId ?? '', modules);
      },
    };
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;
````

## File: unpack/webpack/unpack-webpack-5.ts
````typescript
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Bundle } from '..';
import type { Transform } from '../../ast-utils';
import { anySubList, renameParameters } from '../../ast-utils';
import { WebpackBundle } from './bundle';
import {
  findAssignedEntryId,
  getModuleFunctions,
  modulesContainerMatcher,
  webpackRequireFunctionMatcher,
} from './common-matchers';
import { WebpackModule } from './module';
export default {
  name: 'unpack-webpack-5',
  tags: ['unsafe'],
  scope: true,
  visitor(options = { bundle: undefined }) {
    const { webpackRequire, containerId } = webpackRequireFunctionMatcher();
    const container = modulesContainerMatcher();
    const matcher = m.blockStatement(
      anySubList<t.Statement>(
        m.variableDeclaration(undefined, [
          m.variableDeclarator(containerId, container),
        ]),
        webpackRequire,
      ),
    );
    return {
      BlockStatement(path) {
        if (!matcher.match(path.node)) return;
        path.stop();
        const webpackRequireBinding = path.scope.getBinding(
          webpackRequire.current!.id!.name,
        )!;
        const entryId = findAssignedEntryId(webpackRequireBinding);
        const containerPath = path.get(
          container.currentKeys!.join('.'),
        ) as NodePath<t.ArrayExpression | t.ObjectExpression>;
        const modules = new Map<string, WebpackModule>();
        for (const [id, func] of getModuleFunctions(containerPath)) {
          renameParameters(func, ['module', 'exports', 'require']);
          const isEntry = id === entryId;
          const file = t.file(t.program(func.node.body.body));
          modules.set(id, new WebpackModule(id, file, isEntry));
        }
        options.bundle = new WebpackBundle(entryId ?? '', modules);
      },
    };
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;
````

## File: unpack/webpack/unpack-webpack-chunk.ts
````typescript
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as m from '@codemod/matchers';
import type { Bundle } from '..';
import type { Transform } from '../../ast-utils';
import { constMemberExpression, renameParameters } from '../../ast-utils';
import { WebpackBundle } from './bundle';
import { getModuleFunctions, modulesContainerMatcher } from './common-matchers';
import { WebpackModule } from './module';
export default {
  name: 'unpack-webpack-chunk',
  tags: ['unsafe'],
  scope: true,
  visitor(options = { bundle: undefined }) {
    const container = modulesContainerMatcher();
    const jsonpGlobal = m.capture(
      constMemberExpression(
        m.or(m.identifier(), m.thisExpression()),
        m.matcher((property) => property.startsWith('webpack')),
      ),
    );
    const chunkIds = m.capture(
      m.arrayOf(m.or(m.numericLiteral(), m.stringLiteral())),
    );
    const matcher = m.callExpression(
      constMemberExpression(
        m.assignmentExpression(
          '=',
          jsonpGlobal,
          m.logicalExpression(
            '||',
            m.fromCapture(jsonpGlobal),
            m.arrayExpression([]),
          ),
        ),
        'push',
      ),
      [
        m.arrayExpression(
          m.anyList(
            m.arrayExpression(chunkIds),
            container,
            m.zeroOrMore(),
          ),
        ),
      ],
    );
    return {
      CallExpression(path) {
        if (!matcher.match(path.node)) return;
        path.stop();
        const modules = new Map<string, WebpackModule>();
        const containerPath = path.get(
          container.currentKeys!.join('.'),
        ) as NodePath<t.ArrayExpression | t.ObjectExpression>;
        for (const [id, func] of getModuleFunctions(containerPath)) {
          renameParameters(func, ['module', 'exports', 'require']);
          const isEntry = false;
          const file = t.file(t.program(func.node.body.body));
          modules.set(id, new WebpackModule(id, file, isEntry));
        }
        options.bundle = new WebpackBundle('', modules);
      },
    };
  },
} satisfies Transform<{ bundle: Bundle | undefined }>;
````

## File: unpack/webpack/varInjection.ts
````typescript
import { statement } from '@babel/template';
import type { Statement } from '@babel/types';
import * as m from '@codemod/matchers';
import { constMemberExpression } from '../../ast-utils';
import type { WebpackModule } from './module';
const buildVar = statement`var NAME = INIT;`;
/**
 * ```js
 * (function(global) {
 *   // ...
 * }.call(exports, require(7)))
 * ```
 * ->
 * ```js
 * var global = require(7);
 * // ...
 * ```
 */
export function inlineVarInjections(module: WebpackModule): void {
  const { program } = module.ast;
  const newBody: Statement[] = [];
  const body = m.capture(m.blockStatement());
  const params = m.capture(m.arrayOf(m.identifier()));
  const args = m.capture(
    m.anyList(m.or(m.thisExpression(), m.identifier('exports')), m.oneOrMore()),
  );
  const matcher = m.expressionStatement(
    m.callExpression(
      constMemberExpression(
        m.functionExpression(undefined, params, body),
        'call',
      ),
      args,
    ),
  );
  for (const node of program.body) {
    if (matcher.match(node)) {
      const vars = params.current!.map((param, i) =>
        buildVar({ NAME: param, INIT: args.current![i + 1] }),
      );
      newBody.push(...vars);
      newBody.push(...body.current!.body);
      // We can skip replacing uses of `this` because it always refers to the exports
    } else {
      newBody.push(node);
    }
  }
  program.body = newBody;
}
````

## File: utils/platform.ts
````typescript
export function isBrowser(): boolean {
  return typeof window !== 'undefined' || typeof importScripts !== 'undefined';
}
````
