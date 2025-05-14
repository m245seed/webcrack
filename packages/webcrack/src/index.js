#!/usr/bin/env node
const t = require('@babel/types');
const { parse } = require('@babel/parser');
const babelGenerateDefault = require('@babel/generator').default;
const traverseDefault = require('@babel/traverse').default;
const { visitors } = require('@babel/traverse');
const templateDefault = require('@babel/template').default;
const { statement, expression } = require('@babel/template');
const m = require('@codemod/matchers');
const { program: commanderProgram } = require('commander');
const debugLib = require('debug');
const nodeFS = require('node:fs');
const { readFile: nodeReadFile, rm: nodeRm, mkdir: nodeMkdir, writeFile: nodeWriteFile } = require('node:fs/promises');
const nodePath = require('node:path');
const nodeURL = require('node:url');
function isBrowser() {
    return typeof window !== 'undefined' || typeof importScripts !== 'undefined';
}
function getPropName(node) {
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
const defaultGeneratorOptions = {
    jsescOption: {
        minimal: true
    }
};
function generate(ast, options = defaultGeneratorOptions) {
    return babelGenerateDefault(ast, options).code;
}
function codePreview(node) {
    const code = generate(node, {
        minified: true,
        shouldPrintComment: ()=>false,
        ...defaultGeneratorOptions
    });
    if (code.length > 100) {
        return `${code.slice(0, 70)} … ${code.slice(-30)}`;
    }
    return code;
}
const safeLiteral = m.matcher((node)=>t.isLiteral(node) && (!t.isTemplateLiteral(node) || node.expressions.length === 0));
function infiniteLoop(body) {
    return m.or(m.forStatement(undefined, null, undefined, body), m.forStatement(undefined, truthyMatcher, undefined, body), m.whileStatement(truthyMatcher, body));
}
function constKey(name) {
    return m.or(m.identifier(name), m.stringLiteral(name));
}
function constObjectProperty(value) {
    return m.or(m.objectProperty(m.identifier(), value, false), m.objectProperty(m.or(m.stringLiteral(), m.numericLiteral()), value));
}
function anonymousFunction(params, body) {
    return m.or(m.functionExpression(null, params, body, false), m.arrowFunctionExpression(params, body));
}
function iife(params, body) {
    return m.callExpression(anonymousFunction(params, body));
}
function constMemberExpression(object, property) {
    if (typeof object === 'string') object = m.identifier(object);
    return m.or(m.memberExpression(object, m.identifier(property), false), m.memberExpression(object, m.stringLiteral(property), true));
}
const undefinedMatcher = m.or(m.identifier('undefined'), m.unaryExpression('void', t.numericLiteral(0)));
const trueMatcher = m.or(m.booleanLiteral(true), m.unaryExpression('!', m.numericLiteral(0)), m.unaryExpression('!', m.unaryExpression('!', m.numericLiteral(1))), m.unaryExpression('!', m.unaryExpression('!', m.arrayExpression([]))));
const falseMatcher = m.or(m.booleanLiteral(false), m.unaryExpression('!', m.arrayExpression([])));
const truthyMatcher = m.or(trueMatcher, m.arrayExpression([]));
function findParent(path, matcher) {
    return path.findParent((path)=>matcher.match(path.node));
}
function findPath(path, matcher) {
    return path.find((path)=>matcher.match(path.node));
}
function createFunctionMatcher(params, body) {
    const captures = Array.from({
        length: params
    }, ()=>m.capture(m.anyString()));
    return m.functionExpression(undefined, captures.map(m.identifier), m.blockStatement(body(...captures.map((c)=>m.identifier(m.fromCapture(c))))));
}
function isReadonlyObject(binding, memberAccess) {
    if (!binding.constant && binding.constantViolations[0] !== binding.path) return false;
    function isPatternAssignment(member) {
        const { parentPath } = member;
        return parentPath?.isArrayPattern() || parentPath?.parentPath?.isObjectPattern() && (parentPath.isObjectProperty({
            value: member.node
        }) || parentPath.isRestElement()) || parentPath?.isAssignmentPattern({
            left: member.node
        });
    }
    return binding.referencePaths.every((path)=>memberAccess.match(path.parent) && !path.parentPath?.parentPath?.isAssignmentExpression({
            left: path.parent
        }) && !path.parentPath?.parentPath?.isUpdateExpression({
            argument: path.parent
        }) && !path.parentPath?.parentPath?.isUnaryExpression({
            argument: path.parent,
            operator: 'delete'
        }) && !isPatternAssignment(path.parentPath));
}
function isTemporaryVariable(binding, references, kind = 'var') {
    return binding !== undefined && binding.references === references && binding.constantViolations.length === 1 && (kind === 'var' ? binding.path.isVariableDeclarator() && binding.path.node.init === null : binding.path.listKey === 'params' && binding.path.isIdentifier());
}
class AnySubListMatcher extends m.Matcher {
    constructor(matchers){
        super();
        this.matchers = matchers;
    }
    matchValue(array, keys) {
        if (!Array.isArray(array)) return false;
        if (this.matchers.length === 0 && array.length === 0) return true;
        let j = 0;
        for(let i = 0; i < array.length; i++){
            const matches = this.matchers[j].matchValue(array[i], [
                ...keys,
                i
            ]);
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
function anySubList(...elements) {
    return new AnySubListMatcher(elements);
}
function inlineVariable(binding, value = m.anyExpression(), unsafeAssignments = false) {
    const varDeclarator = binding.path.node;
    const varMatcher = m.variableDeclarator(m.identifier(binding.identifier.name), value);
    const assignmentMatcher = m.assignmentExpression('=', m.identifier(binding.identifier.name), value);
    if (binding.constant && varMatcher.match(varDeclarator)) {
        binding.referencePaths.forEach((ref)=>{
            ref.replaceWith(varDeclarator.init);
        });
        binding.path.remove();
    } else if (unsafeAssignments && binding.constantViolations.length >= 1) {
        const assignments = binding.constantViolations.map((path)=>path.node).filter((node)=>assignmentMatcher.match(node));
        if (!assignments.length) return;
        function getNearestAssignment(location) {
            return assignments.findLast((assignment)=>assignment.start < location);
        }
        for (const ref of binding.referencePaths){
            const assignment = getNearestAssignment(ref.node.start);
            if (assignment) ref.replaceWith(assignment.right);
        }
        for (const path of binding.constantViolations){
            if (path.parentPath?.isExpressionStatement()) {
                path.remove();
            } else if (path.isAssignmentExpression()) {
                path.replaceWith(path.node.right);
            }
        }
        binding.path.remove();
    }
}
function inlineArrayElements(array, references) {
    for (const reference of references){
        const memberPath = reference.parentPath;
        const { property } = memberPath.node;
        const index = property.value;
        const replacement = array.elements[index];
        memberPath.replaceWith(t.cloneNode(replacement));
    }
}
function inlineObjectProperties(binding, property = m.objectProperty()) {
    const varDeclarator = binding.path.node;
    const objectProperties = m.capture(m.arrayOf(property));
    const varMatcher = m.variableDeclarator(m.identifier(binding.identifier.name), m.objectExpression(objectProperties));
    if (!varMatcher.match(varDeclarator)) return;
    const propertyMap = new Map(objectProperties.current.map((p)=>[
            getPropName(p.key),
            p.value
        ]));
    if (!binding.referencePaths.every((ref)=>{
        const member = ref.parent;
        const propName = getPropName(member.property);
        return propertyMap.has(propName);
    })) return;
    binding.referencePaths.forEach((ref)=>{
        const memberPath = ref.parentPath;
        const propName = getPropName(memberPath.node.property);
        const value = propertyMap.get(propName);
        memberPath.replaceWith(value);
    });
    binding.path.remove();
}
function inlineFunctionCall(fn, caller) {
    if (t.isRestElement(fn.params[1])) {
        caller.replaceWith(t.callExpression(caller.node.arguments[0], caller.node.arguments.slice(1)));
        return;
    }
    const returnedValue = fn.body.body[0].argument;
    const clone = t.cloneNode(returnedValue, true);
    traverseDefault(clone, {
        Identifier (path) {
            const paramIndex = fn.params.findIndex((p)=>p.name === path.node.name);
            if (paramIndex !== -1) {
                path.replaceWith(caller.node.arguments[paramIndex] ?? t.unaryExpression('void', t.numericLiteral(0)));
                path.skip();
            }
        },
        noScope: true
    });
    caller.replaceWith(clone);
}
function inlineFunctionAliases(binding) {
    const state = {
        changes: 0
    };
    const refs = [
        ...binding.referencePaths
    ];
    for (const ref of refs){
        const fn = findParent(ref, m.functionDeclaration());
        const fnName = m.capture(m.anyString());
        const returnedCall = m.capture(m.callExpression(m.identifier(binding.identifier.name), m.anyList(m.slice({
            min: 2
        }))));
        const matcher = m.functionDeclaration(m.identifier(fnName), m.anyList(m.slice({
            min: 2
        })), m.blockStatement([
            m.returnStatement(returnedCall)
        ]));
        if (fn && matcher.match(fn.node)) {
            const paramUsedInDecodeCall = fn.node.params.some((param)=>{
                const binding = fn.scope.getBinding(param.name);
                return binding?.referencePaths.some((ref)=>ref.findParent((p)=>p.node === returnedCall.current));
            });
            if (!paramUsedInDecodeCall) continue;
            const fnBinding = fn.scope.parent.getBinding(fnName.current);
            if (!fnBinding) continue;
            const fnRefs = fnBinding.referencePaths;
            refs.push(...fnRefs);
            const callRefs = fnRefs.filter((ref)=>t.isCallExpression(ref.parent) && t.isIdentifier(ref.parent.callee, {
                    name: fnName.current
                })).map((ref)=>ref.parentPath);
            for (const callRef of callRefs){
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
function inlineVariableAliases(binding, targetName = binding.identifier.name) {
    const state = {
        changes: 0
    };
    const refs = [
        ...binding.referencePaths
    ];
    const varName = m.capture(m.anyString());
    const matcher = m.or(m.variableDeclarator(m.identifier(varName), m.identifier(binding.identifier.name)), m.assignmentExpression('=', m.identifier(varName), m.identifier(binding.identifier.name)));
    for (const ref of refs){
        if (matcher.match(ref.parent)) {
            const varScope = ref.scope;
            const varBinding = varScope.getBinding(varName.current);
            if (!varBinding) continue;
            if (ref.isIdentifier({
                name: varBinding.identifier.name
            })) continue;
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
        } else {
            ref.replaceWith(t.identifier(targetName));
        }
        state.changes++;
    }
    return state;
}
function renameFast(binding, newName) {
    binding.referencePaths.forEach((ref)=>{
        if (ref.isExportDefaultDeclaration()) return;
        if (!ref.isIdentifier()) {
            throw new Error(`Unexpected reference (${ref.type}): ${codePreview(ref.node)}`);
        }
        if (ref.scope.hasBinding(newName)) ref.scope.rename(newName);
        ref.node.name = newName;
    });
    const patternMatcher = m.assignmentExpression('=', m.or(m.arrayPattern(), m.objectPattern()));
    binding.constantViolations.forEach((ref)=>{
        if (ref.scope.hasBinding(newName)) ref.scope.rename(newName);
        if (ref.isAssignmentExpression() && t.isIdentifier(ref.node.left)) {
            ref.node.left.name = newName;
        } else if (ref.isUpdateExpression() && t.isIdentifier(ref.node.argument)) {
            ref.node.argument.name = newName;
        } else if (ref.isUnaryExpression({
            operator: 'delete'
        }) && t.isIdentifier(ref.node.argument)) {
            ref.node.argument.name = newName;
        } else if (ref.isVariableDeclarator() && t.isIdentifier(ref.node.id)) {
            ref.node.id.name = newName;
        } else if (ref.isVariableDeclarator() && t.isArrayPattern(ref.node.id)) {
            const ids = ref.getBindingIdentifiers();
            for(const id in ids){
                if (id === binding.identifier.name) {
                    ids[id].name = newName;
                }
            }
        } else if (ref.isFor() || patternMatcher.match(ref.node)) {
            traverseDefault(ref.node, {
                Identifier (path) {
                    if (path.scope !== ref.scope) return path.skip();
                    if (path.node.name === binding.identifier.name) {
                        path.node.name = newName;
                    }
                },
                noScope: true
            });
        } else if (ref.isFunctionDeclaration() && t.isIdentifier(ref.node.id)) {
            ref.node.id.name = newName;
        } else {
            throw new Error(`Unexpected constant violation (${ref.type}): ${codePreview(ref.node)}`);
        }
    });
    binding.scope.removeOwnBinding(binding.identifier.name);
    binding.scope.bindings[newName] = binding;
    binding.identifier.name = newName;
}
function renameParameters(path, newNames) {
    const { params } = path.node;
    for(let i = 0; i < Math.min(params.length, newNames.length); i++){
        const binding = path.scope.getBinding(params[i].name);
        renameFast(binding, newNames[i]);
    }
}
function generateUid(scope, name = 'temp') {
    let uid = '';
    let i = 1;
    do {
        uid = t.toIdentifier(i > 1 ? `${name}${i}` : name);
        i++;
    }while (scope.hasLabel(uid) || scope.hasBinding(uid) || scope.hasGlobal(uid) || scope.hasReference(uid))
    const program = scope.getProgramParent();
    program.references[uid] = true;
    program.uids[uid] = true;
    return uid;
}
const loggerForTransforms = debugLib('webcrack:transforms');
async function applyTransformAsync(ast, transform, options) {
    loggerForTransforms(`${transform.name}: started`);
    const state = {
        changes: 0
    };
    await transform.run?.(ast, state, options);
    if (transform.visitor) traverseDefault(ast, transform.visitor(options), undefined, state);
    loggerForTransforms(`${transform.name}: finished with ${state.changes} changes`);
    return state;
}
function applyTransform(ast, transform, options) {
    loggerForTransforms(`${transform.name}: started`);
    const state = {
        changes: 0
    };
    transform.run?.(ast, state, options);
    if (transform.visitor) {
        const visitor = transform.visitor(options);
        visitor.noScope = !transform.scope;
        traverseDefault(ast, visitor, undefined, state);
    }
    loggerForTransforms(`${transform.name}: finished with ${state.changes} changes`);
    return state;
}
function applyTransforms(ast, transforms, options = {}) {
    options.log ??= true;
    const name = options.name ?? transforms.map((t)=>t.name).join(', ');
    if (options.log) loggerForTransforms(`${name}: started`);
    const state = {
        changes: 0
    };
    for (const transform of transforms){
        transform.run?.(ast, state);
    }
    const traverseOptions = transforms.flatMap((t)=>t.visitor?.() ?? []);
    if (traverseOptions.length > 0) {
        const visitor = visitors.merge(traverseOptions);
        visitor.noScope = options.noScope || transforms.every((t)=>!t.scope);
        traverseDefault(ast, visitor, undefined, state);
    }
    if (options.log) loggerForTransforms(`${name}: finished with ${state.changes} changes`);
    return state;
}
function mergeTransforms(options) {
    return {
        name: options.name,
        tags: options.tags,
        scope: options.transforms.some((t)=>t.scope),
        visitor () {
            return visitors.merge(options.transforms.flatMap((t)=>t.visitor?.() ?? []));
        }
    };
}
async function createNodeSandbox() {
    return async (code)=>{
        const { default: { Isolate } } = await import('isolated-vm');
        const isolate = new Isolate();
        const context = await isolate.createContext();
        const result = await context.eval(code, {
            timeout: 10_000,
            copy: true,
            filename: 'file:///obfuscated.js'
        });
        context.release();
        isolate.dispose();
        return result;
    };
}
function createBrowserSandbox() {
    return ()=>{
        throw new Error('Custom Sandbox implementation required.');
    };
}
class VMDecoder {
    constructor(sandbox, stringArray, decoders, rotator){
        this.sandbox = sandbox;
        this.decoders = decoders;
        const generateOptions = {
            compact: true,
            shouldPrintComment: ()=>false
        };
        const stringArrayCode = generate(stringArray.path.node, generateOptions);
        const rotatorCode = rotator ? generate(rotator.node, generateOptions) : '';
        const decoderCode = decoders.map((decoder)=>generate(decoder.path.node, generateOptions)).join(';\n');
        this.setupCode = [
            stringArrayCode,
            rotatorCode,
            decoderCode
        ].join(';\n');
    }
    async decode(calls) {
        const code = `(() => {
      ${this.setupCode}
      return [${calls.join(',')}]
    })()`;
        try {
            return await this.sandbox(code);
        } catch (error) {
            debugLib('webcrack:deobfuscate')('vm code:', code);
            if (error instanceof Error && (error.message.includes('undefined symbol') || error.message.includes('Segmentation fault'))) {
                throw new Error('isolated-vm version mismatch. Check https://webcrack.netlify.app/docs/guide/common-errors.html#isolated-vm', {
                    cause: error
                });
            }
            throw error;
        }
    }
}
function findStringArray(ast) {
    let result;
    const functionName = m.capture(m.anyString());
    const arrayIdentifier = m.capture(m.identifier());
    const arrayExpression = m.capture(m.arrayExpression(m.arrayOf(m.or(m.stringLiteral(), undefinedMatcher))));
    const functionAssignment = m.assignmentExpression('=', m.identifier(m.fromCapture(functionName)), m.functionExpression(undefined, [], m.blockStatement([
        m.returnStatement(m.fromCapture(arrayIdentifier))
    ])));
    const variableDeclaration = m.variableDeclaration(undefined, [
        m.variableDeclarator(arrayIdentifier, arrayExpression)
    ]);
    const matcher = m.functionDeclaration(m.identifier(functionName), [], m.or(m.blockStatement([
        variableDeclaration,
        m.returnStatement(m.callExpression(functionAssignment))
    ]), m.blockStatement([
        variableDeclaration,
        m.expressionStatement(functionAssignment),
        m.returnStatement(m.callExpression(m.identifier(functionName)))
    ])));
    traverseDefault(ast, {
        FunctionDeclaration (path) {
            if (!matcher.match(path.node)) {
                return;
            }
            const { length } = arrayExpression.current.elements;
            const name = functionName.current;
            const binding = path.scope.getBinding(name);
            renameFast(binding, '__STRING_ARRAY__');
            result = {
                path,
                references: binding.referencePaths,
                originalName: name,
                name: '__STRING_ARRAY__',
                length
            };
            path.stop();
        },
        VariableDeclaration (path) {
            if (!variableDeclaration.match(path.node)) return;
            const { length } = arrayExpression.current.elements;
            const binding = path.scope.getBinding(arrayIdentifier.current.name);
            const memberAccess = m.memberExpression(m.fromCapture(arrayIdentifier), m.numericLiteral(m.matcher((value)=>value < length)));
            if (!binding.referenced || !isReadonlyObject(binding, memberAccess)) return;
            inlineArrayElements(arrayExpression.current, binding.referencePaths);
            path.remove();
        }
    });
    return result;
}
function findArrayRotator(stringArray) {
    const arrayIdentifier = m.capture(m.identifier());
    const pushShift = m.callExpression(constMemberExpression(arrayIdentifier, 'push'), [
        m.callExpression(constMemberExpression(m.fromCapture(arrayIdentifier), 'shift'))
    ]);
    const callMatcher = iife(m.anything(), m.blockStatement(m.anyList(m.zeroOrMore(), infiniteLoop(m.matcher((node)=>{
        return m.containerOf(m.callExpression(m.identifier('parseInt'))).match(node) && m.blockStatement([
            m.tryStatement(m.containerOf(pushShift), m.containerOf(pushShift))
        ]).match(node);
    })))));
    const matcher = m.expressionStatement(m.or(callMatcher, m.unaryExpression('!', callMatcher)));
    for (const ref of stringArray.references){
        const rotator = findParent(ref, matcher);
        if (rotator) {
            return rotator;
        }
    }
}
class Decoder {
    constructor(originalName, name, path){
        this.originalName = originalName;
        this.name = name;
        this.path = path;
    }
    collectCalls() {
        const calls = [];
        const literalArgument = m.or(m.binaryExpression(m.anything(), m.matcher((node)=>literalArgument.match(node)), m.matcher((node)=>literalArgument.match(node))), m.unaryExpression('-', m.matcher((node)=>literalArgument.match(node))), m.numericLiteral(), m.stringLiteral());
        const literalCall = m.callExpression(m.identifier(this.name), m.arrayOf(literalArgument));
        const expressionCall = m.callExpression(m.identifier(this.name), m.arrayOf(m.anyExpression()));
        const conditional = m.capture(m.conditionalExpression());
        const conditionalCall = m.callExpression(m.identifier(this.name), [
            conditional
        ]);
        const buildExtractedConditional = expression`TEST ? CALLEE(CONSEQUENT) : CALLEE(ALTERNATE)`;
        const binding = this.path.scope.getBinding(this.name);
        for (const ref of binding.referencePaths){
            if (conditionalCall.match(ref.parent)) {
                const [replacement] = ref.parentPath.replaceWith(buildExtractedConditional({
                    TEST: conditional.current.test,
                    CALLEE: ref.parent.callee,
                    CONSEQUENT: conditional.current.consequent,
                    ALTERNATE: conditional.current.alternate
                }));
                replacement.scope.crawl();
            } else if (literalCall.match(ref.parent)) {
                calls.push(ref.parentPath);
            } else if (expressionCall.match(ref.parent)) {
                ref.parentPath.traverse({
                    ReferencedIdentifier (path) {
                        const varBinding = path.scope.getBinding(path.node.name);
                        if (!varBinding) return;
                        inlineVariable(varBinding, literalArgument, true);
                    }
                });
                if (literalCall.match(ref.parent)) {
                    calls.push(ref.parentPath);
                }
            } else if (ref.parentPath?.isExpressionStatement()) {
                ref.parentPath.remove();
            }
        }
        return calls;
    }
}
function findDecoders(stringArray) {
    const decoders = [];
    const functionName = m.capture(m.anyString());
    const arrayIdentifier = m.capture(m.identifier());
    const matcher = m.functionDeclaration(m.identifier(functionName), m.anything(), m.blockStatement(anySubList(m.variableDeclaration(undefined, [
        m.variableDeclarator(arrayIdentifier, m.callExpression(m.identifier(stringArray.name)))
    ]), m.containerOf(m.memberExpression(m.fromCapture(arrayIdentifier), undefined, true)))));
    for (const ref of stringArray.references){
        const decoderFn = findParent(ref, matcher);
        if (decoderFn) {
            const oldName = functionName.current;
            const newName = `__DECODE_${decoders.length}__`;
            const binding = decoderFn.scope.getBinding(oldName);
            renameFast(binding, newName);
            decoders.push(new Decoder(oldName, newName, decoderFn));
        }
    }
    return decoders;
}
const mergeStringsTransform = {
    name: 'merge-strings',
    tags: [
        'safe'
    ],
    visitor () {
        const left = m.capture(m.stringLiteral());
        const right = m.capture(m.stringLiteral());
        const matcher = m.binaryExpression('+', m.or(left, m.binaryExpression('+', m.anything(), left)), right);
        return {
            BinaryExpression: {
                exit (path) {
                    if (!matcher.match(path.node)) return;
                    left.current.value += right.current.value;
                    right.current.value = '';
                    path.replaceWith(path.node.left);
                    path.skip();
                    this.changes++;
                }
            }
        };
    }
};
const controlFlowObjectTransform = {
    name: 'control-flow-object',
    tags: [
        'safe'
    ],
    scope: true,
    visitor () {
        const varId = m.capture(m.identifier());
        const propertyName = m.matcher((name)=>/^[a-z]{5}$/i.test(name));
        const propertyKey = constKey(propertyName);
        const propertyValue = m.or(m.stringLiteral(), createFunctionMatcher(2, (left, right)=>[
                m.returnStatement(m.or(m.binaryExpression(undefined, left, right), m.logicalExpression(undefined, left, right), m.binaryExpression(undefined, right, left), m.logicalExpression(undefined, right, left)))
            ]), m.matcher((node)=>{
            return t.isFunctionExpression(node) && createFunctionMatcher(node.params.length, (...params)=>[
                    m.returnStatement(m.callExpression(params[0], params.slice(1)))
                ]).match(node);
        }), (()=>{
            const fnName = m.capture(m.identifier());
            const restName = m.capture(m.identifier());
            return m.functionExpression(undefined, [
                fnName,
                m.restElement(restName)
            ], m.blockStatement([
                m.returnStatement(m.callExpression(m.fromCapture(fnName), [
                    m.spreadElement(m.fromCapture(restName))
                ]))
            ]));
        })());
        const objectProperties = m.capture(m.arrayOf(m.objectProperty(propertyKey, propertyValue)));
        const aliasId = m.capture(m.identifier());
        const aliasVar = m.variableDeclaration(m.anything(), [
            m.variableDeclarator(aliasId, m.fromCapture(varId))
        ]);
        const assignedKey = m.capture(propertyName);
        const assignedValue = m.capture(propertyValue);
        const assignment = m.expressionStatement(m.assignmentExpression('=', constMemberExpression(m.fromCapture(varId), assignedKey), assignedValue));
        const looseAssignment = m.expressionStatement(m.assignmentExpression('=', constMemberExpression(m.fromCapture(varId), assignedKey)));
        const memberAccess = constMemberExpression(m.or(m.fromCapture(varId), m.fromCapture(aliasId)), propertyName);
        const varMatcher = m.variableDeclarator(varId, m.objectExpression(objectProperties));
        const inlineMatcher = constMemberExpression(m.objectExpression(objectProperties), propertyName);
        function isConstantBinding(binding) {
            return binding.constant || binding.constantViolations[0] === binding.path;
        }
        function transform(path) {
            let changes = 0;
            if (varMatcher.match(path.node)) {
                const binding = path.scope.getBinding(varId.current.name);
                if (!binding) return changes;
                if (!isConstantBinding(binding)) return changes;
                if (!transformObjectKeys(binding)) return changes;
                if (!isReadonlyObject(binding, memberAccess)) return changes;
                const props = new Map(objectProperties.current.map((p)=>[
                        getPropName(p.key),
                        p.value
                    ]));
                if (!props.size) return changes;
                const oldRefs = [
                    ...binding.referencePaths
                ];
                [
                    ...binding.referencePaths
                ].reverse().forEach((ref)=>{
                    const memberPath = ref.parentPath;
                    const propName = getPropName(memberPath.node.property);
                    const value = props.get(propName);
                    if (!value) {
                        ref.addComment('leading', 'webcrack:control_flow_missing_prop');
                        return;
                    }
                    if (t.isStringLiteral(value)) {
                        memberPath.replaceWith(value);
                    } else {
                        inlineFunctionCall(value, memberPath.parentPath);
                    }
                    changes++;
                });
                oldRefs.forEach((ref)=>{
                    const varDeclarator = findParent(ref, m.variableDeclarator());
                    if (varDeclarator) changes += transform(varDeclarator);
                });
                path.remove();
                changes++;
            }
            return changes;
        }
        function transformObjectKeys(objBinding) {
            const { container } = objBinding.path.parentPath;
            const startIndex = objBinding.path.parentPath.key + 1;
            const properties = [];
            for(let i = startIndex; i < container.length; i++){
                const statementNode = container[i];
                if (looseAssignment.match(statementNode)) {
                    applyTransform(statementNode, mergeStringsTransform);
                }
                if (assignment.match(statementNode)) {
                    properties.push(t.objectProperty(t.identifier(assignedKey.current), assignedValue.current));
                } else {
                    break;
                }
            }
            const aliasAssignment = container[startIndex + properties.length];
            if (!aliasVar.match(aliasAssignment)) return true;
            if (objBinding.references !== properties.length + 1) return false;
            const aliasBinding = objBinding.scope.getBinding(aliasId.current.name);
            if (!isReadonlyObject(aliasBinding, memberAccess)) return false;
            objectProperties.current.push(...properties);
            container.splice(startIndex, properties.length);
            objBinding.referencePaths = aliasBinding.referencePaths;
            objBinding.references = aliasBinding.references;
            objBinding.identifier.name = aliasBinding.identifier.name;
            aliasBinding.path.remove();
            return true;
        }
        return {
            VariableDeclarator: {
                exit (path) {
                    this.changes += transform(path);
                }
            },
            MemberExpression: {
                exit (path) {
                    if (!inlineMatcher.match(path.node)) return;
                    const propName = getPropName(path.node.property);
                    const value = objectProperties.current.find((prop)=>getPropName(prop.key) === propName)?.value;
                    if (!value) return;
                    if (t.isStringLiteral(value)) {
                        path.replaceWith(value);
                    } else if (path.parentPath.isCallExpression()) {
                        inlineFunctionCall(value, path.parentPath);
                    } else {
                        path.replaceWith(value);
                    }
                    this.changes++;
                }
            }
        };
    }
};
const controlFlowSwitchTransform = {
    name: 'control-flow-switch',
    tags: [
        'safe'
    ],
    visitor () {
        const sequenceName = m.capture(m.identifier());
        const sequenceString = m.capture(m.matcher((s)=>/^\d+(\|\d+)*$/.test(s)));
        const iterator = m.capture(m.identifier());
        const cases = m.capture(m.arrayOf(m.switchCase(m.stringLiteral(m.matcher((s)=>/^\d+$/.test(s))), m.anyList(m.zeroOrMore(), m.or(m.continueStatement(), m.returnStatement())))));
        const matcher = m.blockStatement(m.anyList(m.variableDeclaration(undefined, [
            m.variableDeclarator(sequenceName, m.callExpression(constMemberExpression(m.stringLiteral(sequenceString), 'split'), [
                m.stringLiteral('|')
            ]))
        ]), m.variableDeclaration(undefined, [
            m.variableDeclarator(iterator)
        ]), infiniteLoop(m.blockStatement([
            m.switchStatement(m.memberExpression(m.fromCapture(sequenceName), m.updateExpression('++', m.fromCapture(iterator)), true), cases),
            m.breakStatement()
        ])), m.zeroOrMore()));
        return {
            BlockStatement: {
                exit (path) {
                    if (!matcher.match(path.node)) return;
                    const caseStatements = new Map(cases.current.map((c)=>[
                            c.test.value,
                            t.isContinueStatement(c.consequent.at(-1)) ? c.consequent.slice(0, -1) : c.consequent
                        ]));
                    const sequence = sequenceString.current.split('|');
                    const newStatements = sequence.flatMap((s)=>caseStatements.get(s));
                    path.node.body.splice(0, 3, ...newStatements);
                    this.changes += newStatements.length + 3;
                }
            }
        };
    }
};
const deadCodeTransform = {
    name: 'dead-code',
    tags: [
        'unsafe'
    ],
    scope: true,
    visitor () {
        const stringComparison = m.binaryExpression(m.or('===', '==', '!==', '!='), m.stringLiteral(), m.stringLiteral());
        const testMatcher = m.or(stringComparison, m.unaryExpression('!', stringComparison));
        return {
            'IfStatement|ConditionalExpression': {
                exit (_path) {
                    if (!testMatcher.match(_path.node.test)) return;
                    if (_path.get('test').evaluateTruthy()) {
                        replaceDeadCode(_path, _path.get('consequent'));
                    } else if (_path.node.alternate) {
                        replaceDeadCode(_path, _path.get('alternate'));
                    } else {
                        _path.remove();
                    }
                    this.changes++;
                }
            }
        };
    }
};
function replaceDeadCode(path, replacement) {
    if (t.isBlockStatement(replacement.node)) {
        const childBindings = replacement.scope.bindings;
        for(const name in childBindings){
            const binding = childBindings[name];
            if (path.scope.hasOwnBinding(name)) {
                renameFast(binding, path.scope.generateUid(name));
            }
            binding.scope = path.scope;
            path.scope.bindings[binding.identifier.name] = binding;
        }
        path.replaceWithMultiple(replacement.node.body);
        return;
    }
    path.replaceWith(replacement);
}
const debugProtectionTransform = {
    name: 'debug-protection',
    tags: [
        'safe'
    ],
    scope: true,
    visitor () {
        const ret = m.capture(m.identifier());
        const debugProtectionFunctionName = m.capture(m.anyString());
        const debuggerProtection = m.capture(m.identifier());
        const counter = m.capture(m.identifier());
        const debuggerTemplate = m.ifStatement(undefined, undefined, m.containerOf(m.or(m.debuggerStatement(), m.callExpression(constMemberExpression(m.anyExpression(), 'constructor'), [
            m.stringLiteral('debugger')
        ]))));
        const intervalCall = m.callExpression(constMemberExpression(m.anyExpression(), 'setInterval'), [
            m.identifier(m.fromCapture(debugProtectionFunctionName)),
            m.numericLiteral()
        ]);
        const matcher = m.functionDeclaration(m.identifier(debugProtectionFunctionName), [
            ret
        ], m.blockStatement([
            m.functionDeclaration(debuggerProtection, [
                counter
            ], m.blockStatement([
                debuggerTemplate,
                m.expressionStatement(m.callExpression(m.fromCapture(debuggerProtection), [
                    m.updateExpression('++', m.fromCapture(counter), true)
                ]))
            ])),
            m.tryStatement(m.blockStatement([
                m.ifStatement(m.fromCapture(ret), m.blockStatement([
                    m.returnStatement(m.fromCapture(debuggerProtection))
                ]), m.blockStatement([
                    m.expressionStatement(m.callExpression(m.fromCapture(debuggerProtection), [
                        m.numericLiteral(0)
                    ]))
                ]))
            ]))
        ]));
        return {
            FunctionDeclaration (path) {
                if (!matcher.match(path.node)) return;
                const binding = path.scope.getBinding(debugProtectionFunctionName.current);
                binding?.referencePaths.forEach((ref)=>{
                    if (intervalCall.match(ref.parent)) {
                        findParent(ref, iife())?.remove();
                    }
                });
                path.remove();
                this.changes++;
            }
        };
    }
};
const ATOB = typeof atob === 'function' ? atob : (str)=>Buffer.from(str, 'base64').toString('binary');
const UNESCAPE = typeof unescape === 'function' ? unescape : (str)=>{
    return String(str).replace(/%([0-9A-Fa-f]{2})/g, (match, p1)=>String.fromCharCode(parseInt(p1, 16))).replace(/%u([0-9A-Fa-f]{4})/g, (match, p1)=>String.fromCharCode(parseInt(p1, 16)));
};
const DECODE_URI = typeof decodeURI === 'function' ? decodeURI : (str)=>{
    try {
        return decodeURIComponent(str.replace(/\+/g, ' '));
    } catch  {
        return str;
    }
};
const DECODE_URI_COMPONENT = typeof decodeURIComponent === 'function' ? decodeURIComponent : (str)=>{
    try {
        return global.decodeURIComponent(str);
    } catch  {
        return str;
    }
};
const FUNCTIONS_EVALUATE_GLOBALS = {
    atob: ATOB,
    unescape: UNESCAPE,
    decodeURI: DECODE_URI,
    decodeURIComponent: DECODE_URI_COMPONENT
};
const evaluateGlobalsTransform = {
    name: 'evaluate-globals',
    tags: [
        'safe'
    ],
    scope: true,
    visitor () {
        const name = m.capture(m.or(...Object.keys(FUNCTIONS_EVALUATE_GLOBALS)));
        const arg = m.capture(m.anyString());
        const matcher = m.callExpression(m.identifier(name), [
            m.stringLiteral(arg)
        ]);
        return {
            CallExpression: {
                exit (path) {
                    if (!matcher.match(path.node)) return;
                    if (path.scope.hasBinding(name.current, {
                        noGlobals: true
                    })) return;
                    try {
                        const value = FUNCTIONS_EVALUATE_GLOBALS[name.current].call(globalThis, arg.current);
                        path.replaceWith(t.stringLiteral(value));
                        this.changes++;
                    } catch  {}
                }
            }
        };
    }
};
const inlineDecodedStringsTransform = {
    name: 'inline-decoded-strings',
    tags: [
        'unsafe'
    ],
    scope: true,
    async run (ast, state, options) {
        if (!options) return;
        const calls = options.vm.decoders.flatMap((decoder)=>decoder.collectCalls());
        const decodedValues = await options.vm.decode(calls);
        for(let i = 0; i < calls.length; i++){
            const call = calls[i];
            const value = decodedValues[i];
            call.replaceWith(t.valueToNode(value));
            if (typeof value !== 'string') call.addComment('leading', 'webcrack:decode_error');
        }
        state.changes += calls.length;
    }
};
const inlineDecoderWrappersTransform = {
    name: 'inline-decoder-wrappers',
    tags: [
        'unsafe'
    ],
    scope: true,
    run (ast, state, decoder) {
        if (!decoder?.node.id) return;
        const decoderName = decoder.node.id.name;
        const decoderBinding = decoder.parentPath.scope.getBinding(decoderName);
        if (decoderBinding) {
            state.changes += inlineVariableAliases(decoderBinding).changes;
            state.changes += inlineFunctionAliases(decoderBinding).changes;
        }
    }
};
const inlineObjectPropsTransform = {
    name: 'inline-object-props',
    tags: [
        'safe'
    ],
    scope: true,
    visitor () {
        const varId = m.capture(m.identifier());
        const propertyName = m.capture(m.matcher((name)=>/^[\w]+$/i.test(name)));
        const propertyKey = constKey(propertyName);
        const objectProperties = m.capture(m.arrayOf(m.objectProperty(propertyKey, m.or(m.stringLiteral(), m.numericLiteral()))));
        const memberAccess = constMemberExpression(m.fromCapture(varId), propertyName);
        const varMatcher = m.variableDeclarator(varId, m.objectExpression(objectProperties));
        const literalMemberAccess = constMemberExpression(m.objectExpression(objectProperties), propertyName);
        return {
            MemberExpression (path) {
                if (!literalMemberAccess.match(path.node)) return;
                const property = objectProperties.current.find((p)=>getPropName(p.key) === propertyName.current);
                if (!property) return;
                path.replaceWith(property.value);
                this.changes++;
            },
            VariableDeclarator (path) {
                if (!varMatcher.match(path.node)) return;
                if (objectProperties.current.length === 0) return;
                const binding = path.scope.getBinding(varId.current.name);
                if (!binding || !isReadonlyObject(binding, memberAccess)) return;
                inlineObjectProperties(binding, m.objectProperty(propertyKey, m.or(m.stringLiteral(), m.numericLiteral())));
                this.changes++;
            }
        };
    }
};
const mergeObjectAssignmentsTransform = {
    name: 'merge-object-assignments',
    tags: [
        'safe'
    ],
    scope: true,
    visitor: ()=>{
        const id = m.capture(m.identifier());
        const object = m.capture(m.objectExpression([]));
        const varMatcher = m.variableDeclaration(undefined, [
            m.variableDeclarator(id, object)
        ]);
        const key = m.capture(m.anyExpression());
        const computed = m.capture(m.anything());
        const value = m.capture(m.anyExpression());
        const assignmentMatcher = m.expressionStatement(m.assignmentExpression('=', m.memberExpression(m.fromCapture(id), key, computed), value));
        function hasCircularReferenceMergeObj(node, binding) {
            return binding.referencePaths.some((path)=>path.find((p)=>p.node === node)) || m.containerOf(m.callExpression()).match(node);
        }
        const repeatedCallMatcherMergeObj = m.or(m.forStatement(), m.forOfStatement(), m.forInStatement(), m.whileStatement(), m.doWhileStatement(), m.function(), m.objectMethod(), m.classBody());
        function isRepeatedCallReferenceMergeObj(binding, reference) {
            const block = binding.scope.getBlockParent().path;
            const repeatable = findParent(reference, repeatedCallMatcherMergeObj);
            return repeatable?.isDescendant(block);
        }
        const inlineableObjectMergeObj = m.matcher((node)=>m.or(safeLiteral, m.arrayExpression(m.arrayOf(inlineableObjectMergeObj)), m.objectExpression(m.arrayOf(constObjectProperty(inlineableObjectMergeObj)))).match(node));
        return {
            Program (path) {
                path.scope.crawl();
            },
            VariableDeclaration: {
                exit (path) {
                    if (!path.inList || !varMatcher.match(path.node)) return;
                    const binding = path.scope.getBinding(id.current.name);
                    const { container } = path;
                    const siblingIndex = path.key + 1;
                    while(siblingIndex < container.length){
                        const sibling = path.getSibling(siblingIndex);
                        if (!assignmentMatcher.match(sibling.node) || hasCircularReferenceMergeObj(value.current, binding)) return;
                        const isComputed = computed.current && key.current.type !== 'NumericLiteral' && key.current.type !== 'StringLiteral';
                        object.current.properties.push(t.objectProperty(key.current, value.current, isComputed));
                        sibling.remove();
                        binding.dereference();
                        binding.referencePaths = binding.referencePaths.filter((p)=>p.parentPath !== sibling);
                        if (binding.references === 1 && inlineableObjectMergeObj.match(object.current) && !isRepeatedCallReferenceMergeObj(binding, binding.referencePaths[0])) {
                            binding.referencePaths[0].replaceWith(object.current);
                            path.remove();
                            this.changes++;
                        }
                    }
                }
            }
        };
    }
};
const selfDefendingTransform = {
    name: 'self-defending',
    tags: [
        'safe'
    ],
    scope: true,
    visitor () {
        const callController = m.capture(m.anyString());
        const firstCall = m.capture(m.identifier());
        const rfn = m.capture(m.identifier());
        const context = m.capture(m.identifier());
        const res = m.capture(m.identifier());
        const fn = m.capture(m.identifier());
        const matcher = m.variableDeclarator(m.identifier(callController), iife([], m.blockStatement([
            m.variableDeclaration(undefined, [
                m.variableDeclarator(firstCall, trueMatcher)
            ]),
            m.returnStatement(m.functionExpression(null, [
                context,
                fn
            ], m.blockStatement([
                m.variableDeclaration(undefined, [
                    m.variableDeclarator(rfn, m.conditionalExpression(m.fromCapture(firstCall), m.functionExpression(null, [], m.blockStatement([
                        m.ifStatement(m.fromCapture(fn), m.blockStatement([
                            m.variableDeclaration(undefined, [
                                m.variableDeclarator(res, m.callExpression(constMemberExpression(m.fromCapture(fn), 'apply'), [
                                    m.fromCapture(context),
                                    m.identifier('arguments')
                                ]))
                            ]),
                            m.expressionStatement(m.assignmentExpression('=', m.fromCapture(fn), m.nullLiteral())),
                            m.returnStatement(m.fromCapture(res))
                        ]))
                    ])), m.functionExpression(null, [], m.blockStatement([]))))
                ]),
                m.expressionStatement(m.assignmentExpression('=', m.fromCapture(firstCall), falseMatcher)),
                m.returnStatement(m.fromCapture(rfn))
            ])))
        ])));
        const emptyIife = iife([], m.blockStatement([]));
        function removeSelfDefendingRefs(path) {
            const varName = m.capture(m.anyString());
            const varMatcher = m.variableDeclarator(m.identifier(varName), m.callExpression(m.identifier(path.node.name)));
            const callMatcher = m.expressionStatement(m.callExpression(m.identifier(m.fromCapture(varName)), []));
            const varDecl = findParent(path, varMatcher);
            if (!varDecl) {
                return;
            }
            const binding = varDecl.scope.getBinding(varName.current);
            binding?.referencePaths.forEach((ref)=>{
                if (callMatcher.match(ref.parentPath?.parent)) ref.parentPath?.parentPath?.remove();
            });
            varDecl.remove();
        }
        return {
            VariableDeclarator (path) {
                if (!matcher.match(path.node)) return;
                const binding = path.scope.getBinding(callController.current);
                if (!binding) return;
                binding.referencePaths.filter((ref)=>ref.parent.type === 'CallExpression').forEach((ref)=>{
                    if (ref.parentPath?.parent.type === 'CallExpression') {
                        ref.parentPath.parentPath?.remove();
                    } else {
                        removeSelfDefendingRefs(ref);
                    }
                    findParent(ref, emptyIife)?.remove();
                    this.changes++;
                });
                path.remove();
                this.changes++;
            }
        };
    }
};
const varFunctionsTransform = {
    name: 'var-functions',
    tags: [
        'unsafe'
    ],
    visitor () {
        const name = m.capture(m.identifier());
        const fn = m.capture(m.functionExpression(null));
        const matcher = m.variableDeclaration('var', [
            m.variableDeclarator(name, fn)
        ]);
        return {
            VariableDeclaration: {
                exit (path) {
                    if (matcher.match(path.node) && path.key !== 'init') {
                        path.replaceWith(t.functionDeclaration(name.current, fn.current.params, fn.current.body, fn.current.generator, fn.current.async));
                        this.changes++;
                    }
                }
            }
        };
    }
};
const deobfuscateMainTransform = {
    name: 'deobfuscate',
    tags: [
        'unsafe'
    ],
    scope: true,
    async run (ast, state, sandbox) {
        if (!sandbox) return;
        const logger = debugLib('webcrack:deobfuscate');
        const stringArray = findStringArray(ast);
        logger(stringArray ? `String Array: ${stringArray.originalName}, length ${stringArray.length}` : 'String Array: no');
        if (!stringArray) return;
        const rotator = findArrayRotator(stringArray);
        logger(`String Array Rotate: ${rotator ? 'yes' : 'no'}`);
        const decoders = findDecoders(stringArray);
        logger(`String Array Decoders: ${decoders.map((d)=>d.originalName).join(', ')}`);
        state.changes += applyTransform(ast, inlineObjectPropsTransform).changes;
        for (const decoder of decoders){
            state.changes += applyTransform(ast, inlineDecoderWrappersTransform, decoder.path).changes;
        }
        const vm = new VMDecoder(sandbox, stringArray, decoders, rotator);
        state.changes += (await applyTransformAsync(ast, inlineDecodedStringsTransform, {
            vm
        })).changes;
        if (decoders.length > 0) {
            stringArray.path.remove();
            rotator?.remove();
            decoders.forEach((decoder)=>decoder.path.remove());
            state.changes += 2 + decoders.length;
        }
        state.changes += applyTransforms(ast, [
            mergeStringsTransform,
            deadCodeTransform,
            controlFlowObjectTransform,
            controlFlowSwitchTransform
        ], {
            noScope: true
        }).changes;
    }
};
const defaultParametersTransform = {
    name: 'default-parameters',
    tags: [
        'safe'
    ],
    scope: true,
    visitor () {
        const defaultExpression = m.capture(m.anyExpression());
        const index = m.capture(m.numericLiteral());
        const varName = m.capture(m.identifier());
        const varId = m.capture(m.or(m.identifier(), m.arrayPattern(), m.objectPattern()));
        const argumentCheckAnd = m.logicalExpression('&&', m.binaryExpression('>', constMemberExpression('arguments', 'length'), index), m.binaryExpression('!==', m.memberExpression(m.identifier('arguments'), m.fromCapture(index), true), m.identifier('undefined')));
        const argumentCheckOr = m.logicalExpression('||', m.binaryExpression('<=', constMemberExpression('arguments', 'length'), index), m.binaryExpression('===', m.memberExpression(m.identifier('arguments'), m.fromCapture(index), true), m.identifier('undefined')));
        const defaultParam = m.variableDeclaration(undefined, [
            m.variableDeclarator(varId, m.conditionalExpression(argumentCheckAnd, m.memberExpression(m.identifier('arguments'), m.fromCapture(index), true), defaultExpression))
        ]);
        const defaultFalseParam = m.variableDeclaration(undefined, [
            m.variableDeclarator(varId, m.logicalExpression('&&', argumentCheckAnd, m.memberExpression(m.identifier('arguments'), m.fromCapture(index), true)))
        ]);
        const defaultTrueParam = m.variableDeclaration(undefined, [
            m.variableDeclarator(varId, m.logicalExpression('||', argumentCheckOr, m.memberExpression(m.identifier('arguments'), m.fromCapture(index), true)))
        ]);
        const defaultParamLoose = m.ifStatement(m.binaryExpression('===', varName, m.identifier('undefined')), m.blockStatement([
            m.expressionStatement(m.assignmentExpression('=', m.fromCapture(varName), defaultExpression))
        ]));
        const normalParam = m.variableDeclaration(undefined, [
            m.variableDeclarator(varId, m.conditionalExpression(m.binaryExpression('>', constMemberExpression('arguments', 'length'), index), m.memberExpression(m.identifier('arguments'), m.fromCapture(index), true), m.identifier('undefined')))
        ]);
        return {
            VariableDeclaration: {
                exit (path) {
                    const fn = path.parentPath.parent;
                    if (!t.isFunction(fn) || path.key !== 0) return;
                    const newParam = defaultParam.match(path.node) ? t.assignmentPattern(varId.current, defaultExpression.current) : defaultFalseParam.match(path.node) ? t.assignmentPattern(varId.current, t.booleanLiteral(false)) : defaultTrueParam.match(path.node) ? t.assignmentPattern(varId.current, t.booleanLiteral(true)) : normalParam.match(path.node) ? varId.current : null;
                    if (!newParam) return;
                    for(let i = fn.params.length; i < index.current.value; i++){
                        fn.params[i] = t.identifier(path.scope.generateUid('param'));
                    }
                    fn.params[index.current.value] = newParam;
                    path.remove();
                    this.changes++;
                }
            },
            IfStatement: {
                exit (path) {
                    const fn = path.parentPath.parent;
                    if (!t.isFunction(fn) || path.key !== 0) return;
                    if (!defaultParamLoose.match(path.node)) return;
                    const binding = path.scope.getOwnBinding(varName.current.name);
                    if (!binding) return;
                    const isFunctionParam = binding.path.listKey === 'params' && binding.path.parent === fn;
                    if (!isFunctionParam) return;
                    binding.path.replaceWith(t.assignmentPattern(varName.current, defaultExpression.current));
                    path.remove();
                    this.changes++;
                }
            }
        };
    }
};
const logicalAssignmentsTransform = {
    name: 'logical-assignments',
    tags: [
        'safe'
    ],
    scope: true,
    visitor () {
        const operator = m.capture(m.or('||', '&&'));
        const left = m.capture(m.or(m.identifier(), m.memberExpression()));
        const right = m.capture(m.anyExpression());
        const idMatcher = m.logicalExpression(operator, left, m.assignmentExpression('=', m.fromCapture(left), right));
        const object = m.capture(m.anyExpression());
        const property = m.capture(m.anyExpression());
        const tmpVar = m.capture(m.identifier());
        const member = m.capture(m.memberExpression(m.fromCapture(tmpVar), m.fromCapture(property)));
        const memberMatcher = m.logicalExpression(operator, m.memberExpression(m.assignmentExpression('=', tmpVar, object), property), m.assignmentExpression('=', member, right));
        const computedMemberMatcher = m.logicalExpression(operator, m.memberExpression(object, m.assignmentExpression('=', tmpVar, property), true), m.assignmentExpression('=', m.memberExpression(m.fromCapture(object), m.fromCapture(tmpVar), true), right));
        const tmpVar2 = m.capture(m.identifier());
        const multiComputedMemberMatcher = m.logicalExpression(operator, m.memberExpression(m.assignmentExpression('=', tmpVar, object), m.assignmentExpression('=', tmpVar2, property), true), m.assignmentExpression('=', m.memberExpression(m.fromCapture(tmpVar), m.fromCapture(tmpVar2), true), right));
        return {
            LogicalExpression: {
                exit (path) {
                    if (idMatcher.match(path.node)) {
                        path.replaceWith(t.assignmentExpression(`${operator.current}=`, left.current, right.current));
                        this.changes++;
                    } else if (memberMatcher.match(path.node)) {
                        const binding = path.scope.getBinding(tmpVar.current.name);
                        if (!isTemporaryVariable(binding, 1)) return;
                        binding.path.remove();
                        member.current.object = object.current;
                        path.replaceWith(t.assignmentExpression(`${operator.current}=`, member.current, right.current));
                        this.changes++;
                    } else if (computedMemberMatcher.match(path.node)) {
                        const binding = path.scope.getBinding(tmpVar.current.name);
                        if (!isTemporaryVariable(binding, 1)) return;
                        binding.path.remove();
                        path.replaceWith(t.assignmentExpression(`${operator.current}=`, t.memberExpression(object.current, property.current, true), right.current));
                        this.changes++;
                    } else if (multiComputedMemberMatcher.match(path.node)) {
                        const binding = path.scope.getBinding(tmpVar.current.name);
                        const binding2 = path.scope.getBinding(tmpVar2.current.name);
                        if (!isTemporaryVariable(binding, 1) || !isTemporaryVariable(binding2, 1)) return;
                        binding.path.remove();
                        binding2.path.remove();
                        path.replaceWith(t.assignmentExpression(`${operator.current}=`, t.memberExpression(object.current, property.current, true), right.current));
                        this.changes++;
                    }
                }
            }
        };
    }
};
const nullishCoalescingTransform = {
    name: 'nullish-coalescing',
    tags: [
        'safe'
    ],
    scope: true,
    visitor () {
        const tmpVar = m.capture(m.identifier());
        const left = m.capture(m.anyExpression());
        const right = m.capture(m.anyExpression());
        const idMatcher = m.conditionalExpression(m.logicalExpression('&&', m.binaryExpression('!==', m.assignmentExpression('=', tmpVar, left), m.nullLiteral()), m.binaryExpression('!==', m.fromCapture(tmpVar), m.identifier('undefined'))), m.fromCapture(tmpVar), right);
        const idLooseMatcher = m.conditionalExpression(m.binaryExpression('!=', m.assignmentExpression('=', tmpVar, left), m.nullLiteral()), m.fromCapture(tmpVar), right);
        const simpleIdMatcher = m.conditionalExpression(m.or(m.logicalExpression('&&', m.binaryExpression('!==', left, m.nullLiteral()), m.binaryExpression('!==', m.fromCapture(left), m.identifier('undefined'))), m.binaryExpression('!=', left, m.nullLiteral())), m.fromCapture(left), right);
        const iifeMatcher = m.callExpression(m.arrowFunctionExpression([
            m.fromCapture(tmpVar)
        ], m.anyExpression(), false), []);
        return {
            ConditionalExpression: {
                exit (path) {
                    if (idMatcher.match(path.node)) {
                        const binding = path.scope.getBinding(tmpVar.current.name);
                        if (iifeMatcher.match(path.parentPath.parent) && isTemporaryVariable(binding, 2, 'param')) {
                            path.parentPath.parentPath.replaceWith(t.logicalExpression('??', left.current, right.current));
                            this.changes++;
                        } else if (isTemporaryVariable(binding, 2, 'var')) {
                            binding.path.remove();
                            path.replaceWith(t.logicalExpression('??', left.current, right.current));
                            this.changes++;
                        }
                    } else if (idLooseMatcher.match(path.node)) {
                        const binding = path.scope.getBinding(tmpVar.current.name);
                        if (!isTemporaryVariable(binding, 1)) return;
                        binding.path.remove();
                        path.replaceWith(t.logicalExpression('??', left.current, right.current));
                        this.changes++;
                    } else if (simpleIdMatcher.match(path.node)) {
                        path.replaceWith(t.logicalExpression('??', left.current, right.current));
                        this.changes++;
                    }
                }
            }
        };
    }
};
const nullishCoalescingAssignmentTransform = {
    name: 'nullish-coalescing-assignment',
    tags: [
        'safe'
    ],
    scope: true,
    visitor () {
        const tmpVar = m.capture(m.identifier());
        const leftId = m.capture(m.identifier());
        const property = m.capture(m.identifier());
        const right = m.capture(m.anyExpression());
        const computed = m.capture(m.anything());
        const memberMatcher = m.logicalExpression('??', m.memberExpression(m.assignmentExpression('=', tmpVar, leftId), property, computed), m.assignmentExpression('=', m.memberExpression(m.fromCapture(tmpVar), m.fromCapture(property), computed), right));
        const left = m.capture(m.or(m.identifier(), m.memberExpression()));
        const simpleMatcher = m.logicalExpression('??', left, m.assignmentExpression('=', m.fromCapture(left), right));
        return {
            LogicalExpression: {
                exit (path) {
                    if (memberMatcher.match(path.node)) {
                        const binding = path.scope.getBinding(tmpVar.current.name);
                        if (!isTemporaryVariable(binding, 1)) return;
                        binding.path.remove();
                        path.replaceWith(t.assignmentExpression('??=', t.memberExpression(leftId.current, property.current, computed.current), right.current));
                        this.changes++;
                        return;
                    }
                    if (simpleMatcher.match(path.node)) {
                        path.replaceWith(t.assignmentExpression('??=', left.current, right.current));
                        this.changes++;
                    }
                }
            }
        };
    }
};
const optionalChainingTransform = {
    name: 'optional-chaining',
    tags: [
        'safe'
    ],
    scope: true,
    visitor () {
        const object = m.capture(m.anyExpression());
        const member = m.capture(m.memberExpression(m.fromCapture(object)));
        const simpleMatcher = m.conditionalExpression(m.logicalExpression('||', m.binaryExpression('===', object, m.nullLiteral()), m.binaryExpression('===', m.fromCapture(object), m.identifier('undefined'))), m.identifier('undefined'), member);
        const tmpVar = m.capture(m.identifier());
        const tmpMember = m.capture(m.memberExpression(m.fromCapture(tmpVar)));
        const tmpMatcher = m.conditionalExpression(m.logicalExpression('||', m.binaryExpression('===', m.assignmentExpression('=', tmpVar, object), m.nullLiteral()), m.binaryExpression('===', m.fromCapture(tmpVar), m.identifier('undefined'))), m.identifier('undefined'), tmpMember);
        return {
            ConditionalExpression: {
                exit (path) {
                    if (simpleMatcher.match(path.node)) {
                        member.current.optional = true;
                        path.replaceWith(t.optionalMemberExpression(object.current, member.current.property, member.current.computed, true));
                        this.changes++;
                        return;
                    }
                    if (!tmpMatcher.match(path.node)) {
                        return;
                    }
                    const binding = path.scope.getBinding(tmpVar.current.name);
                    if (!isTemporaryVariable(binding, 2)) return;
                    binding.path.remove();
                    tmpMember.current.optional = true;
                    path.replaceWith(t.optionalMemberExpression(object.current, tmpMember.current.property, tmpMember.current.computed, true));
                    this.changes++;
                }
            }
        };
    }
};
function escapeTemplateLiteral(str) {
    return str.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('\0', '\\0').replaceAll('\b', '\\b').replaceAll('\f', '\\f').replaceAll('\r', '\\r').replaceAll('\t', '\\t').replaceAll('\v', '\\v');
}
function pushToTemplate(template, value) {
    if (value.type === 'StringLiteral') {
        const lastQuasi = template.quasis.at(-1);
        lastQuasi.value.raw += escapeTemplateLiteral(value.value);
    } else if (value.type === 'TemplateLiteral') {
        const lastQuasi = template.quasis.at(-1);
        const firstQuasi = value.quasis[0];
        lastQuasi.value.raw += firstQuasi.value.raw;
        template.expressions.push(...value.expressions);
        template.quasis.push(...value.quasis.slice(1));
    } else {
        template.expressions.push(value);
        template.quasis.push(t.templateElement({
            raw: ''
        }));
    }
}
function unshiftToTemplate(template, value) {
    if (value.type === 'StringLiteral') {
        const firstQuasi = template.quasis[0];
        firstQuasi.value.raw = escapeTemplateLiteral(value.value) + firstQuasi.value.raw;
    } else {
        template.expressions.unshift(value);
        template.quasis.unshift(t.templateElement({
            raw: ''
        }));
    }
}
const templateLiteralsTransform = {
    name: 'template-literals',
    tags: [
        'unsafe'
    ],
    visitor () {
        const string = m.capture(m.or(m.stringLiteral(), m.templateLiteral()));
        const concatMatcher = m.callExpression(constMemberExpression(string, 'concat'), m.arrayOf(m.anyExpression()));
        return {
            BinaryExpression: {
                exit (path) {
                    if (path.node.operator !== '+') return;
                    if (t.isTemplateLiteral(path.node.left)) {
                        pushToTemplate(path.node.left, path.node.right);
                        path.replaceWith(path.node.left);
                        this.changes++;
                        return;
                    }
                    if (!(t.isTemplateLiteral(path.node.right) && t.isExpression(path.node.left))) {
                        return;
                    }
                    unshiftToTemplate(path.node.right, path.node.left);
                    path.replaceWith(path.node.right);
                    this.changes++;
                }
            },
            CallExpression: {
                exit (path) {
                    if (!concatMatcher.match(path.node)) {
                        return;
                    }
                    const template = t.templateLiteral([
                        t.templateElement({
                            raw: ''
                        })
                    ], []);
                    pushToTemplate(template, string.current);
                    for (const arg of path.node.arguments){
                        pushToTemplate(template, arg);
                    }
                    path.replaceWith(template);
                    this.changes++;
                }
            }
        };
    }
};
const allTranspileTransforms = [
    defaultParametersTransform,
    logicalAssignmentsTransform,
    nullishCoalescingTransform,
    nullishCoalescingAssignmentTransform,
    optionalChainingTransform,
    templateLiteralsTransform
];
const transpileTransform = mergeTransforms({
    name: 'transpile',
    tags: [
        'safe'
    ],
    transforms: allTranspileTransforms
});
const blockStatementsTransform = {
    name: 'block-statements',
    tags: [
        'safe'
    ],
    visitor: ()=>({
            IfStatement: {
                exit (path) {
                    if (!t.isBlockStatement(path.node.consequent) && !t.isEmptyStatement(path.node.consequent)) {
                        path.node.consequent = t.blockStatement([
                            path.node.consequent
                        ]);
                        this.changes++;
                    }
                    if (path.node.alternate && !t.isBlockStatement(path.node.alternate)) {
                        path.node.alternate = t.blockStatement([
                            path.node.alternate
                        ]);
                        this.changes++;
                    }
                }
            },
            Loop: {
                exit (path) {
                    if (!t.isBlockStatement(path.node.body) && !t.isEmptyStatement(path.node.body)) {
                        path.node.body = t.blockStatement([
                            path.node.body
                        ]);
                        this.changes++;
                    }
                }
            },
            ArrowFunctionExpression: {
                exit (path) {
                    if (t.isSequenceExpression(path.node.body)) {
                        path.node.body = t.blockStatement([
                            t.returnStatement(path.node.body)
                        ]);
                        this.changes++;
                    }
                }
            }
        })
};
const { isIdentifierName } = require('@babel/helper-validator-identifier');
const computedPropertiesTransform = {
    name: 'computed-properties',
    tags: [
        'safe'
    ],
    visitor () {
        const stringMatcher = m.capture(m.stringLiteral(m.matcher(isIdentifierName)));
        const propertyMatcher = m.or(m.memberExpression(m.anything(), stringMatcher, true), m.optionalMemberExpression(m.anything(), stringMatcher, true));
        const keyMatcher = m.or(m.objectProperty(stringMatcher), m.classProperty(stringMatcher), m.objectMethod(undefined, stringMatcher), m.classMethod(undefined, stringMatcher));
        return {
            'MemberExpression|OptionalMemberExpression': {
                exit (path) {
                    if (!propertyMatcher.match(path.node)) return;
                    path.node.computed = false;
                    path.node.property = t.identifier(stringMatcher.current.value);
                    this.changes++;
                }
            },
            'ObjectProperty|ClassProperty|ObjectMethod|ClassMethod': {
                exit (path) {
                    if (!keyMatcher.match(path.node)) return;
                    if (path.type === 'ClassMethod' && stringMatcher.current.value === 'constructor' || path.type === 'ObjectProperty' && stringMatcher.current.value === '__proto__') return;
                    path.node.computed = false;
                    path.node.key = t.identifier(stringMatcher.current.value);
                    this.changes++;
                }
            }
        };
    }
};
const forToWhileTransform = {
    name: 'for-to-while',
    tags: [
        'safe'
    ],
    visitor () {
        return {
            ForStatement: {
                exit (path) {
                    const { test, body, init, update } = path.node;
                    if (init || update) return;
                    path.replaceWith(t.whileStatement(test ?? t.booleanLiteral(true), body));
                    this.changes++;
                }
            }
        };
    }
};
const infinityTransform = {
    name: 'infinity',
    tags: [
        'safe'
    ],
    scope: true,
    visitor: ()=>{
        const infinityMatcher = m.binaryExpression('/', m.numericLiteral(1), m.numericLiteral(0));
        const negativeInfinityMatcher = m.binaryExpression('/', m.unaryExpression('-', m.numericLiteral(1)), m.numericLiteral(0));
        return {
            BinaryExpression: {
                exit (path) {
                    if (path.scope.hasBinding('Infinity', {
                        noGlobals: true
                    })) return;
                    if (infinityMatcher.match(path.node)) {
                        path.replaceWith(t.identifier('Infinity'));
                        this.changes++;
                    } else if (negativeInfinityMatcher.match(path.node)) {
                        path.replaceWith(t.unaryExpression('-', t.identifier('Infinity')));
                        this.changes++;
                    }
                }
            }
        };
    }
};
const INVERTED_BINARY_OPERATORS_UNMINIFY = {
    '==': '!=',
    '===': '!==',
    '!=': '==',
    '!==': '==='
};
const INVERTED_LOGICAL_OPERATORS_UNMINIFY = {
    '||': '&&',
    '&&': '||'
};
const invertBooleanLogicTransform = {
    name: 'invert-boolean-logic',
    tags: [
        'safe'
    ],
    visitor: ()=>{
        const logicalExpression = m.logicalExpression(m.or(...Object.values(INVERTED_LOGICAL_OPERATORS_UNMINIFY)));
        const logicalMatcher = m.unaryExpression('!', logicalExpression);
        const binaryExpression = m.capture(m.binaryExpression(m.or(...Object.values(INVERTED_BINARY_OPERATORS_UNMINIFY))));
        const binaryMatcher = m.unaryExpression('!', binaryExpression);
        return {
            UnaryExpression: {
                exit (path) {
                    const { argument } = path.node;
                    if (binaryMatcher.match(path.node)) {
                        binaryExpression.current.operator = INVERTED_BINARY_OPERATORS_UNMINIFY[binaryExpression.current.operator];
                        path.replaceWith(binaryExpression.current);
                        this.changes++;
                        return;
                    }
                    if (!logicalMatcher.match(path.node)) {
                        return;
                    }
                    let current = argument;
                    while(logicalExpression.match(current)){
                        current.operator = INVERTED_LOGICAL_OPERATORS_UNMINIFY[current.operator];
                        current.right = t.unaryExpression('!', current.right);
                        if (!logicalExpression.match(current.left)) {
                            current.left = t.unaryExpression('!', current.left);
                        }
                        current = current.left;
                    }
                    path.replaceWith(argument);
                    this.changes++;
                }
            }
        };
    }
};
const jsonParseTransform = {
    name: 'json-parse',
    tags: [
        'safe'
    ],
    scope: true,
    visitor: ()=>{
        const string = m.capture(m.anyString());
        const matcher = m.callExpression(constMemberExpression('JSON', 'parse'), [
            m.stringLiteral(string)
        ]);
        return {
            CallExpression: {
                exit (path) {
                    if (matcher.match(path.node) && !path.scope.hasBinding('JSON', {
                        noGlobals: true
                    })) {
                        try {
                            JSON.parse(string.current);
                            const parsed = parse(string.current, {
                                allowReturnOutsideFunction: true
                            }).program.body[0].expression;
                            path.replaceWith(parsed);
                            this.changes++;
                        } catch  {}
                    }
                }
            }
        };
    }
};
const logicalToIfTransform = {
    name: 'logical-to-if',
    tags: [
        'safe'
    ],
    visitor: ()=>{
        const buildIf = statement`if (TEST) { BODY; }`;
        const buildIfNot = statement`if (!TEST) { BODY; }`;
        return {
            ExpressionStatement: {
                exit (path) {
                    const expressionNode = path.node.expression;
                    if (!t.isLogicalExpression(expressionNode)) return;
                    if (expressionNode.operator === '&&') {
                        path.replaceWith(buildIf({
                            TEST: expressionNode.left,
                            BODY: expressionNode.right
                        }));
                        this.changes++;
                    } else if (expressionNode.operator === '||') {
                        path.replaceWith(buildIfNot({
                            TEST: expressionNode.left,
                            BODY: expressionNode.right
                        }));
                        this.changes++;
                    }
                }
            }
        };
    }
};
const mergeElseIfTransform = {
    name: 'merge-else-if',
    tags: [
        'safe'
    ],
    visitor () {
        const nestedIf = m.capture(m.ifStatement());
        const matcher = m.ifStatement(m.anything(), m.anything(), m.blockStatement([
            nestedIf
        ]));
        return {
            IfStatement: {
                exit (path) {
                    if (matcher.match(path.node)) {
                        path.node.alternate = nestedIf.current;
                        this.changes++;
                    }
                }
            }
        };
    }
};
const numberExpressionsMatcher = m.or(m.unaryExpression('-', m.or(m.stringLiteral(), m.numericLiteral())), m.binaryExpression(m.or('+', '-', '/', '%', '*', '**', '&', '|', '>>', '>>>', '<<', '^'), m.or(m.stringLiteral(), m.numericLiteral(), m.unaryExpression('-', m.numericLiteral())), m.or(m.stringLiteral(), m.numericLiteral(), m.unaryExpression('-', m.numericLiteral()))));
const numberExpressionsTransform = {
    name: 'number-expressions',
    tags: [
        'safe'
    ],
    visitor: ()=>({
            'BinaryExpression|UnaryExpression': {
                exit (path) {
                    if (!numberExpressionsMatcher.match(path.node)) return;
                    const evaluated = path.evaluate();
                    if (t.isBinaryExpression(path.node, {
                        operator: '/'
                    }) && !Number.isInteger(evaluated.value)) {
                        return;
                    }
                    path.replaceWith(t.valueToNode(evaluated.value));
                    path.skip();
                    this.changes++;
                }
            }
        })
};
const rawLiteralsTransform = {
    name: 'raw-literals',
    tags: [
        'safe'
    ],
    visitor: ()=>({
            StringLiteral (path) {
                if (path.node.extra) {
                    path.node.extra = undefined;
                    this.changes++;
                }
            },
            NumericLiteral (path) {
                if (path.node.extra) {
                    path.node.extra = undefined;
                    this.changes++;
                }
            }
        })
};
const removeDoubleNotTransform = {
    name: 'remove-double-not',
    tags: [
        'safe'
    ],
    visitor () {
        const expressionMatcher = m.capture(m.anyExpression());
        const doubleNot = m.unaryExpression('!', m.unaryExpression('!', expressionMatcher));
        const tripleNot = m.unaryExpression('!', doubleNot);
        const arrayCall = m.callExpression(constMemberExpression(m.arrayExpression(), m.or('filter', 'find', 'findLast', 'findIndex', 'findLastIndex', 'some', 'every')), [
            m.arrowFunctionExpression(m.anything(), doubleNot)
        ]);
        return {
            Conditional: {
                exit (path) {
                    if (doubleNot.match(path.node.test)) {
                        path.get('test').replaceWith(expressionMatcher.current);
                        this.changes++;
                    }
                }
            },
            UnaryExpression: {
                exit (path) {
                    if (tripleNot.match(path.node)) {
                        path.replaceWith(t.unaryExpression('!', expressionMatcher.current));
                        this.changes++;
                    }
                }
            },
            CallExpression: {
                exit (path) {
                    if (arrayCall.match(path.node)) {
                        path.get('arguments.0.body').replaceWith(expressionMatcher.current);
                        this.changes++;
                    }
                }
            }
        };
    }
};
const sequenceTransform = {
    name: 'sequence',
    tags: [
        'safe'
    ],
    visitor () {
        const assignmentVariable = m.or(m.identifier(), m.memberExpression(m.identifier(), m.or(m.identifier(), safeLiteral)));
        const assignedSequence = m.capture(m.sequenceExpression());
        const assignmentMatcher = m.assignmentExpression(m.or('=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '|=', '^=', '&='), assignmentVariable, assignedSequence);
        return {
            AssignmentExpression: {
                exit (path) {
                    if (!assignmentMatcher.match(path.node)) return;
                    const { expressions } = assignedSequence.current;
                    path.node.right = expressions.pop();
                    const newNodes = path.parentPath.isExpressionStatement() ? expressions.map(t.expressionStatement) : expressions;
                    path.insertBefore(newNodes);
                    this.changes++;
                }
            },
            ExpressionStatement: {
                exit (path) {
                    if (!t.isSequenceExpression(path.node.expression)) return;
                    const statements = path.node.expression.expressions.map(t.expressionStatement);
                    path.replaceWithMultiple(statements);
                    this.changes++;
                }
            },
            ReturnStatement: {
                exit (path) {
                    if (!t.isSequenceExpression(path.node.argument)) return;
                    const { expressions } = path.node.argument;
                    path.node.argument = expressions.pop();
                    const statements = expressions.map(t.expressionStatement);
                    path.insertBefore(statements);
                    this.changes++;
                }
            },
            IfStatement: {
                exit (path) {
                    if (!t.isSequenceExpression(path.node.test)) return;
                    const { expressions } = path.node.test;
                    path.node.test = expressions.pop();
                    const statements = expressions.map(t.expressionStatement);
                    path.insertBefore(statements);
                    this.changes++;
                }
            },
            SwitchStatement: {
                exit (path) {
                    if (!t.isSequenceExpression(path.node.discriminant)) return;
                    const { expressions } = path.node.discriminant;
                    path.node.discriminant = expressions.pop();
                    const statements = expressions.map(t.expressionStatement);
                    path.insertBefore(statements);
                    this.changes++;
                }
            },
            ThrowStatement: {
                exit (path) {
                    if (!t.isSequenceExpression(path.node.argument)) return;
                    const { expressions } = path.node.argument;
                    path.node.argument = expressions.pop();
                    const statements = expressions.map(t.expressionStatement);
                    path.insertBefore(statements);
                    this.changes++;
                }
            },
            ForInStatement: {
                exit (path) {
                    if (!t.isSequenceExpression(path.node.right)) return;
                    const { expressions } = path.node.right;
                    path.node.right = expressions.pop();
                    const statements = expressions.map(t.expressionStatement);
                    path.insertBefore(statements);
                    this.changes++;
                }
            },
            ForOfStatement: {
                exit (path) {
                    if (!t.isSequenceExpression(path.node.right)) return;
                    const { expressions } = path.node.right;
                    path.node.right = expressions.pop();
                    const statements = expressions.map(t.expressionStatement);
                    path.insertBefore(statements);
                    this.changes++;
                }
            },
            ForStatement: {
                exit (path) {
                    if (t.isSequenceExpression(path.node.init)) {
                        const statements = path.node.init.expressions.map(t.expressionStatement);
                        path.node.init = null;
                        path.insertBefore(statements);
                        this.changes++;
                    }
                    if (!(t.isSequenceExpression(path.node.update) && path.node.body.type === 'EmptyStatement')) {
                        return;
                    }
                    const { expressions } = path.node.update;
                    path.node.update = expressions.pop();
                    const statements = expressions.map(t.expressionStatement);
                    path.node.body = t.blockStatement(statements);
                    this.changes++;
                }
            },
            VariableDeclaration: {
                exit (path) {
                    const sequence = m.capture(m.sequenceExpression());
                    const matcher = m.variableDeclaration(undefined, [
                        m.variableDeclarator(undefined, sequence)
                    ]);
                    if (!matcher.match(path.node)) return;
                    const { expressions } = sequence.current;
                    path.node.declarations[0].init = expressions.pop();
                    const statements = expressions.map(t.expressionStatement);
                    path.getStatementParent()?.insertBefore(statements);
                    this.changes++;
                }
            },
            SequenceExpression: {
                exit (path) {
                    const { expressions } = path.node;
                    if (expressions.every((node)=>safeLiteral.match(node))) {
                        path.replaceWith(expressions.at(-1));
                        this.changes++;
                    }
                }
            }
        };
    }
};
const splitForLoopVarsMatcher = m.forStatement(m.variableDeclaration('var', m.arrayOf(m.variableDeclarator(m.identifier()))));
const splitForLoopVarsTransform = {
    name: 'split-for-loop-vars',
    tags: [
        'safe'
    ],
    scope: true,
    visitor: ()=>({
            ForStatement: {
                exit (path) {
                    if (!splitForLoopVarsMatcher.match(path.node)) return;
                    const { init, test, update } = path.node;
                    const { declarations } = init;
                    for(let i = 0; i < declarations.length; i++){
                        const declarator = declarations[i];
                        const binding = path.scope.getBinding(declarator.id.name);
                        if (!binding) break;
                        const isUsedInTestOrUpdate = binding.constantViolations.some((reference)=>reference.find((p)=>p.node === test || p.node === update)) || binding.referencePaths.some((reference)=>reference.find((p)=>p.node === test || p.node === update));
                        if (isUsedInTestOrUpdate) break;
                        path.insertBefore(t.variableDeclaration('var', [
                            declarator
                        ]));
                        declarations.shift();
                        i--;
                        this.changes++;
                    }
                    if (declarations.length === 0) path.get('init').remove();
                }
            }
        })
};
const splitVariableDeclarationsTransform = {
    name: 'split-variable-declarations',
    tags: [
        'safe'
    ],
    visitor: ()=>({
            VariableDeclaration: {
                exit (path) {
                    if (path.node.declarations.length > 1) {
                        if (path.key === 'init' && path.parentPath.isForStatement()) {
                            if (!path.parentPath.node.test && !path.parentPath.node.update && path.node.kind === 'var') {
                                path.parentPath.insertBefore(path.node.declarations.map((declaration)=>t.variableDeclaration(path.node.kind, [
                                        declaration
                                    ])));
                                path.remove();
                                this.changes++;
                            }
                        } else {
                            if (path.parentPath.isExportNamedDeclaration()) {
                                path.parentPath.replaceWithMultiple(path.node.declarations.map((declaration)=>t.exportNamedDeclaration(t.variableDeclaration(path.node.kind, [
                                        declaration
                                    ]))));
                            } else {
                                path.replaceWithMultiple(path.node.declarations.map((declaration)=>t.variableDeclaration(path.node.kind, [
                                        declaration
                                    ])));
                            }
                            this.changes++;
                        }
                    }
                }
            }
        })
};
const ternaryToIfTransform = {
    name: 'ternary-to-if',
    tags: [
        'safe'
    ],
    visitor () {
        const test = m.capture(m.anyExpression());
        const consequent = m.capture(m.anyExpression());
        const alternate = m.capture(m.anyExpression());
        const conditional = m.conditionalExpression(test, consequent, alternate);
        const buildIf = statement`if (TEST) { CONSEQUENT; } else { ALTERNATE; }`;
        const buildIfReturn = statement`if (TEST) { return CONSEQUENT; } else { return ALTERNATE; }`;
        return {
            ExpressionStatement: {
                exit (path) {
                    if (conditional.match(path.node.expression)) {
                        path.replaceWith(buildIf({
                            TEST: test.current,
                            CONSEQUENT: consequent.current,
                            ALTERNATE: alternate.current
                        }));
                        this.changes++;
                    }
                }
            },
            ReturnStatement: {
                exit (path) {
                    if (conditional.match(path.node.argument)) {
                        path.replaceWith(buildIfReturn({
                            TEST: test.current,
                            CONSEQUENT: consequent.current,
                            ALTERNATE: alternate.current
                        }));
                        this.changes++;
                    }
                }
            }
        };
    }
};
const truncateNumberLiteralTransform = {
    name: 'truncate-number-literal',
    tags: [
        'safe'
    ],
    visitor: ()=>{
        const binaryOperators = m.or('|', '&', '^', '<<', '>>', '>>>');
        const literal = m.capture(m.numericLiteral());
        const matcher = m.or(m.binaryExpression(binaryOperators, literal, m.anything()), m.binaryExpression(binaryOperators, m.anything(), literal));
        return {
            BinaryExpression: {
                exit (path) {
                    if (!matcher.match(path.node)) return;
                    const { value } = literal.current;
                    const isShifter = literal.current === path.node.right && (path.node.operator === '<<' || path.node.operator === '>>');
                    const truncation = isShifter ? 31 : 0xff_ff_ff_ff;
                    const truncated = value & truncation;
                    if (truncated === value) return;
                    literal.current.value = truncated;
                }
            }
        };
    }
};
const TYPEOF_UNDEFINED_OPERATOR_MAP = {
    '>': '===',
    '<': '!=='
};
const typeofUndefinedTransform = {
    name: 'typeof-undefined',
    tags: [
        'safe'
    ],
    visitor () {
        const operator = m.capture(m.or('>', '<'));
        const argument = m.capture(m.anyExpression());
        const matcher = m.binaryExpression(operator, m.unaryExpression('typeof', argument), m.stringLiteral('u'));
        return {
            BinaryExpression: {
                exit (path) {
                    if (!matcher.match(path.node)) return;
                    path.replaceWith(t.binaryExpression(TYPEOF_UNDEFINED_OPERATOR_MAP[operator.current], t.unaryExpression('typeof', argument.current), t.stringLiteral('undefined')));
                    this.changes++;
                }
            }
        };
    }
};
const unaryExpressionsTransform = {
    name: 'unary-expressions',
    tags: [
        'safe'
    ],
    visitor () {
        const argument = m.capture(m.anyExpression());
        const matcher = m.expressionStatement(m.unaryExpression(m.or('void', '!', 'typeof'), argument));
        const returnVoid = m.returnStatement(m.unaryExpression('void', argument));
        return {
            ExpressionStatement: {
                exit (path) {
                    if (!matcher.match(path.node)) return;
                    path.replaceWith(argument.current);
                    this.changes++;
                }
            },
            ReturnStatement: {
                exit (path) {
                    if (!returnVoid.match(path.node)) return;
                    path.replaceWith(argument.current);
                    path.insertAfter(t.returnStatement());
                    this.changes++;
                }
            }
        };
    }
};
const unminifyBooleansTrueMatcher = m.or(m.unaryExpression('!', m.numericLiteral(0)), m.unaryExpression('!', m.unaryExpression('!', m.numericLiteral(1))), m.unaryExpression('!', m.unaryExpression('!', m.arrayExpression([]))));
const unminifyBooleansFalseMatcher = m.or(m.unaryExpression('!', m.numericLiteral(1)), m.unaryExpression('!', m.arrayExpression([])));
const unminifyBooleansTransform = {
    name: 'unminify-booleans',
    tags: [
        'safe'
    ],
    visitor: ()=>({
            UnaryExpression (path) {
                if (unminifyBooleansTrueMatcher.match(path.node)) {
                    path.replaceWith(t.booleanLiteral(true));
                    this.changes++;
                } else if (unminifyBooleansFalseMatcher.match(path.node)) {
                    path.replaceWith(t.booleanLiteral(false));
                    this.changes++;
                }
            }
        })
};
const voidToUndefinedTransform = {
    name: 'void-to-undefined',
    tags: [
        'safe'
    ],
    scope: true,
    visitor: ()=>{
        const matcher = m.unaryExpression('void', m.numericLiteral(0));
        return {
            UnaryExpression: {
                exit (path) {
                    if (matcher.match(path.node) && !path.scope.hasBinding('undefined', {
                        noGlobals: true
                    })) {
                        path.replaceWith(t.identifier('undefined'));
                        this.changes++;
                    }
                }
            }
        };
    }
};
const FLIPPED_YODA_OPERATORS = {
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
    '|': '|'
};
const yodaTransform = {
    name: 'yoda',
    tags: [
        'safe'
    ],
    visitor: ()=>{
        const pureValue = m.or(m.stringLiteral(), m.numericLiteral(), m.unaryExpression('-', m.or(m.numericLiteral(), m.identifier('Infinity'))), m.booleanLiteral(), m.nullLiteral(), m.identifier('undefined'), m.identifier('NaN'), m.identifier('Infinity'));
        const matcher = m.binaryExpression(m.or(...Object.values(FLIPPED_YODA_OPERATORS)), pureValue, m.matcher((node)=>!pureValue.match(node)));
        return {
            BinaryExpression: {
                exit (path) {
                    if (matcher.match(path.node)) {
                        path.replaceWith(t.binaryExpression(FLIPPED_YODA_OPERATORS[path.node.operator], path.node.right, path.node.left));
                        this.changes++;
                    }
                }
            }
        };
    }
};
const allUnminifyTransforms = [
    blockStatementsTransform,
    computedPropertiesTransform,
    forToWhileTransform,
    infinityTransform,
    invertBooleanLogicTransform,
    jsonParseTransform,
    logicalToIfTransform,
    mergeElseIfTransform,
    mergeStringsTransform,
    numberExpressionsTransform,
    rawLiteralsTransform,
    removeDoubleNotTransform,
    sequenceTransform,
    splitForLoopVarsTransform,
    splitVariableDeclarationsTransform,
    ternaryToIfTransform,
    truncateNumberLiteralTransform,
    typeofUndefinedTransform,
    unaryExpressionsTransform,
    unminifyBooleansTransform,
    voidToUndefinedTransform,
    yodaTransform
];
const unminifyTransform = mergeTransforms({
    name: 'unminify',
    tags: [
        'safe'
    ],
    transforms: allUnminifyTransforms
});
class UnpackModule {
    constructor(id, ast, isEntry){
        this.id = id;
        this.ast = ast;
        this.isEntry = isEntry;
        this.path = `./${isEntry ? 'index' : id.replace(/\.js$/, '')}.js`;
        this._code = undefined;
    }
    regenerateCode() {
        this._code = generate(this.ast);
        return this._code;
    }
    get code() {
        return this._code ?? this.regenerateCode();
    }
    set code(code) {
        this._code = code;
    }
}
class Bundle {
    constructor(type, entryId, modules){
        this.type = type;
        this.entryId = entryId;
        this.modules = modules;
    }
    applyMappings(mappings) {
        const mappingPaths = Object.keys(mappings);
        if (mappingPaths.length === 0) return;
        const unusedMappings = new Set(mappingPaths);
        for (const module1 of this.modules.values()){
            traverseDefault(module1.ast, {
                enter (path) {
                    for (const mappingPath of mappingPaths){
                        if (mappings[mappingPath].match(path.node)) {
                            if (unusedMappings.has(mappingPath)) {
                                unusedMappings.delete(mappingPath);
                            } else {
                                throw new Error(`Mapping ${mappingPath} is already used.`);
                            }
                            const resolvedPath = mappingPath.startsWith('./') ? mappingPath : `node_modules/${mappingPath}`;
                            module1.path = resolvedPath;
                            path.stop();
                            break;
                        }
                    }
                },
                noScope: true
            });
        }
    }
    async save(bundlePath) {
        const bundleJson = {
            type: this.type,
            entryId: this.entryId,
            modules: Array.from(this.modules.values(), (module1)=>({
                    id: module1.id,
                    path: module1.path
                }))
        };
        await nodeMkdir(bundlePath, {
            recursive: true
        });
        await nodeWriteFile(nodePath.join(bundlePath, 'bundle.json'), JSON.stringify(bundleJson, null, 2), 'utf8');
        await Promise.all(Array.from(this.modules.values(), async (module1)=>{
            const modulePath = nodePath.normalize(nodePath.join(bundlePath, module1.path));
            if (nodePath.relative(bundlePath, modulePath).startsWith('..')) {
                throw new Error(`detected path traversal: ${module1.path}`);
            }
            await nodeMkdir(nodePath.dirname(modulePath), {
                recursive: true
            });
            await nodeWriteFile(modulePath, module1.code, 'utf8');
        }));
    }
    applyTransforms() {}
}
const posixPath = nodePath.posix;
function relativePath(from, to) {
    if (to.startsWith('node_modules/')) return to.replace('node_modules/', '');
    const relPath = posixPath.relative(posixPath.dirname(from), to);
    return relPath.startsWith('.') ? relPath : `./${relPath}`;
}
function resolveDependencyTree(tree, entry) {
    const paths = resolveTreePaths(tree, entry);
    paths[entry] = './index.js';
    const entryDepth = Object.values(paths).reduce((acc, p)=>Math.max(acc, p.split('..').length), 0);
    const prefix = Array(entryDepth - 1).fill(0).map((_, i)=>`tmp${i}`).join('/');
    return Object.fromEntries(Object.entries(paths).map(([id, p])=>{
        const newPath = p.startsWith('node_modules/') ? p : posixPath.join(prefix, p);
        return [
            id,
            newPath
        ];
    }));
}
function resolveTreePaths(graph, entry, cwd = '.', paths = {}) {
    const entries = Object.entries(graph[entry] || {});
    for (const [id, name] of entries){
        const isCircular = Object.hasOwn(paths, id);
        if (isCircular) continue;
        let currentPath;
        if (name.startsWith('.')) {
            currentPath = posixPath.join(cwd, name);
            if (!currentPath.endsWith('.js')) currentPath += '.js';
        } else {
            currentPath = posixPath.join('node_modules', name, 'index.js');
        }
        paths[id] = currentPath;
        const newCwd = currentPath.endsWith('.js') ? posixPath.dirname(currentPath) : currentPath;
        resolveTreePaths(graph, id, newCwd, paths);
    }
    return paths;
}
class BrowserifyModule extends UnpackModule {
    constructor(id, ast, isEntry, dependencies){
        super(id, ast, isEntry);
        this.dependencies = dependencies;
    }
}
class BrowserifyBundle extends Bundle {
    constructor(entryId, modules){
        super('browserify', entryId, modules);
    }
}
const unpackBrowserifyTransform = {
    name: 'unpack-browserify',
    tags: [
        'unsafe'
    ],
    scope: true,
    visitor (options) {
        const modules = new Map();
        const files = m.capture(m.arrayOf(m.objectProperty(m.or(m.numericLiteral(), m.stringLiteral(), m.identifier()), m.arrayExpression([
            m.functionExpression(),
            m.objectExpression(m.arrayOf(m.objectProperty(constKey(), m.or(m.numericLiteral(), m.identifier('undefined'), m.stringLiteral()))))
        ]))));
        const entryIdMatcher = m.capture(m.or(m.numericLiteral(), m.stringLiteral()));
        const matcher = m.callExpression(m.or(m.functionExpression(undefined, [
            m.identifier(),
            m.identifier(),
            m.identifier()
        ]), iife([], m.blockStatement([
            m.functionDeclaration(undefined, [
                m.identifier(),
                m.identifier(),
                m.identifier()
            ]),
            m.returnStatement(m.identifier())
        ]))), [
            m.objectExpression(files),
            m.objectExpression(),
            m.arrayExpression(m.anyList(entryIdMatcher, m.zeroOrMore()))
        ]);
        return {
            CallExpression (path) {
                if (!matcher.match(path.node)) return;
                path.stop();
                const entryId = entryIdMatcher.current.value.toString();
                const modulesPath = path.get(files.currentKeys.join('.'));
                const dependencyTree = {};
                for (const moduleWrapper of modulesPath){
                    const id = getPropName(moduleWrapper.node.key);
                    const fn = moduleWrapper.get('value.elements.0');
                    const dependencies = dependencyTree[id] = {};
                    const dependencyProperties = moduleWrapper.get('value.elements.1').node.properties;
                    for (const dependency of dependencyProperties){
                        if (dependency.value.type !== 'NumericLiteral' && dependency.value.type !== 'StringLiteral') continue;
                        const filePath = getPropName(dependency.key);
                        const depId = dependency.value.value.toString();
                        dependencies[depId] = filePath;
                    }
                    renameParameters(fn, [
                        'require',
                        'module',
                        'exports'
                    ]);
                    const file = t.file(t.program(fn.node.body.body));
                    const module1 = new BrowserifyModule(id, file, id === entryId, dependencies);
                    modules.set(id.toString(), module1);
                }
                const resolvedPaths = resolveDependencyTree(dependencyTree, entryId);
                for (const module1 of modules.values()){
                    if (Object.hasOwn(resolvedPaths, module1.id)) {
                        module1.path = resolvedPaths[module1.id];
                    }
                }
                if (modules.size > 0) {
                    options.bundle = new BrowserifyBundle(entryId, modules);
                }
            }
        };
    }
};
function webpackRequireFunctionMatcher() {
    const containerId = m.capture(m.identifier());
    const webpackRequire = m.capture(m.functionDeclaration(m.identifier(), [
        m.identifier()
    ], m.blockStatement(anySubList(m.expressionStatement(m.callExpression(m.or(constMemberExpression(m.memberExpression(m.fromCapture(containerId), m.identifier(), true), 'call'), m.memberExpression(m.fromCapture(containerId), m.identifier(), true))))))));
    return {
        webpackRequire,
        containerId
    };
}
function modulesContainerMatcher() {
    return m.capture(m.or(m.arrayExpression(m.arrayOf(m.or(anonymousFunction(), m.nullLiteral()))), m.objectExpression(m.arrayOf(m.or(m.objectProperty(m.or(m.numericLiteral(), m.stringLiteral(), m.identifier()), anonymousFunction()), m.objectProperty(m.identifier('c'), m.stringLiteral()))))));
}
function getModuleFunctions(container) {
    const functions = new Map();
    if (t.isArrayExpression(container.node)) {
        container.node.elements.forEach((element, index)=>{
            if (element !== null && (t.isFunctionExpression(element) || t.isArrowFunctionExpression(element))) {
                functions.set(index.toString(), container.get(`elements.${index}`));
            }
        });
    } else {
        container.node.properties.forEach((property, index)=>{
            if (t.isObjectProperty(property)) {
                const key = getPropName(property.key);
                if (key && anonymousFunction().match(property.value)) {
                    functions.set(key, container.get(`properties.${index}.value`));
                }
            }
        });
    }
    return functions;
}
function findAssignedEntryId(webpackRequireBinding) {
    const entryId = m.capture(m.or(m.numericLiteral(), m.stringLiteral()));
    const assignment = m.assignmentExpression('=', constMemberExpression(webpackRequireBinding.identifier.name, 's'), entryId);
    for (const reference of webpackRequireBinding.referencePaths){
        if (assignment.match(reference.parentPath?.parent)) {
            return String(entryId.current.value);
        }
    }
}
function findRequiredEntryId(webpackRequireBinding) {
    const entryId = m.capture(m.or(m.numericLiteral(), m.stringLiteral()));
    const call = m.callExpression(m.identifier(webpackRequireBinding.identifier.name), [
        entryId
    ]);
    for (const reference of webpackRequireBinding.referencePaths){
        if (reference.key === 'callee' && call.match(reference.parent)) {
            return String(entryId.current.value);
        }
    }
}
class WebpackModule extends UnpackModule {
}
const buildVarInjectionVar = statement`var NAME = INIT;`;
function inlineVarInjections(module1) {
    const { program } = module1.ast;
    const newBody = [];
    const body = m.capture(m.blockStatement());
    const params = m.capture(m.arrayOf(m.identifier()));
    const args = m.capture(m.anyList(m.or(m.thisExpression(), m.identifier('exports')), m.oneOrMore()));
    const matcher = m.expressionStatement(m.callExpression(constMemberExpression(m.functionExpression(undefined, params, body), 'call'), args));
    for (const node of program.body){
        if (matcher.match(node)) {
            const vars = params.current.map((param, i)=>buildVarInjectionVar({
                    NAME: param,
                    INIT: args.current[i + 1]
                }));
            newBody.push(...vars);
            newBody.push(...body.current.body);
        } else {
            newBody.push(node);
        }
    }
    program.body = newBody;
}
const buildNamespaceImport = statement`import * as NAME from "PATH";`;
const buildNamedExportLet = statement`export let NAME = VALUE;`;
function convertESM(module1) {
    const defineEsModuleMatcher = m.expressionStatement(m.callExpression(constMemberExpression(m.identifierType('Identifier'), 'r'), [
        m.identifier()
    ]));
    const exportsName = m.capture(m.identifier());
    const exportedName = m.capture(m.anyString());
    const returnedValue = m.capture(m.anyExpression());
    const defineExportMatcher = m.expressionStatement(m.callExpression(constMemberExpression(m.identifierType('Identifier'), 'd'), [
        exportsName,
        m.stringLiteral(exportedName),
        m.functionExpression(undefined, [], m.blockStatement([
            m.returnStatement(returnedValue)
        ]))
    ]));
    const emptyObjectVarMatcher = m.variableDeclarator(m.fromCapture(exportsName), m.objectExpression([]));
    const properties = m.capture(m.arrayOf(m.objectProperty(m.identifier(), m.arrowFunctionExpression([], m.anyExpression()))));
    const defineExportsMatcher = m.expressionStatement(m.callExpression(constMemberExpression(m.identifierType('Identifier'), 'd'), [
        exportsName,
        m.objectExpression(properties)
    ]));
    const requireVariable = m.capture(m.identifier());
    const requiredModuleId = m.capture(m.anyNumber());
    const requireMatcher = m.variableDeclaration(undefined, [
        m.variableDeclarator(requireVariable, m.callExpression(m.identifierType('Identifier'), [
            m.or(m.numericLiteral(requiredModuleId), m.stringLiteral(requiredModuleId))
        ]))
    ]);
    const hmdMatcher = m.expressionStatement(m.assignmentExpression('=', m.identifier('module'), m.callExpression(constMemberExpression(m.identifierType('Identifier'), 'hmd'))));
    function exportVariableEsm(requireDPath, value, exportNameStr) {
        if (value.type === 'Identifier') {
            const binding = requireDPath.scope.getBinding(value.name);
            if (!binding) return;
            const declaration = findPath(binding.path, m.or(m.variableDeclaration(), m.classDeclaration(), m.functionDeclaration()));
            if (!declaration) return;
            if (exportNameStr === 'default') {
                declaration.replaceWith(t.exportDefaultDeclaration(t.isVariableDeclaration(declaration.node) ? declaration.node.declarations[0].init : declaration.node));
            } else {
                renameFast(binding, exportNameStr);
                declaration.replaceWith(t.exportNamedDeclaration(declaration.node, []));
            }
            return;
        }
        if (exportNameStr === 'default') {
            requireDPath.insertAfter(t.exportDefaultDeclaration(value));
        } else {
            requireDPath.insertAfter(buildNamedExportLet({
                NAME: t.identifier(exportNameStr),
                VALUE: value
            }));
        }
    }
    traverseDefault(module1.ast, {
        enter (path) {
            if (path.parentPath?.parentPath && !path.isProgram()) return path.skip();
            if (defineEsModuleMatcher.match(path.node)) {
                module1.ast.program.sourceType = 'module';
                path.remove();
            } else if (module1.ast.program.sourceType === 'module' && requireMatcher.match(path.node) && (path.node.declarations[0].init.callee.name === 'require' || path.node.declarations[0].init.callee.name === module1.webpackRequire)) {
                path.replaceWith(buildNamespaceImport({
                    NAME: requireVariable.current,
                    PATH: String(requiredModuleId.current.value)
                }));
            } else if (defineExportsMatcher.match(path.node)) {
                const exportsBinding = path.scope.getBinding(exportsName.current.name);
                const emptyObject = emptyObjectVarMatcher.match(exportsBinding?.path.node) ? exportsBinding?.path.node.init : null;
                for (const property of properties.current){
                    const exportedKey = property.key;
                    const returnedValueFromArrow = property.value.body;
                    if (emptyObject) {
                        emptyObject.properties.push(t.objectProperty(exportedKey, returnedValueFromArrow));
                    } else {
                        exportVariableEsm(path, returnedValueFromArrow, exportedKey.name);
                    }
                }
                path.remove();
            } else if (defineExportMatcher.match(path.node)) {
                exportVariableEsm(path, returnedValue.current, exportedName.current);
                path.remove();
            } else if (hmdMatcher.match(path.node)) {
                path.remove();
            }
        }
    });
}
const buildDefaultAccessGetDefaultExport = expression`OBJECT.default`;
function convertDefaultRequire(bundle) {
    const requiredModuleId = m.capture(m.or(m.numericLiteral(), m.stringLiteral()));
    const declaratorMatcher = m.variableDeclarator(m.identifier(), m.callExpression(m.identifierType('Identifier'), [
        requiredModuleId
    ]));
    const moduleArg = m.capture(m.identifier());
    const getterVarName = m.capture(m.identifier());
    const requireN = m.callExpression(constMemberExpression(m.identifierType('Identifier'), 'n'), [
        moduleArg
    ]);
    const defaultRequireMatcher = m.variableDeclarator(getterVarName, requireN);
    const defaultRequireMatcherAlternative = m.or(constMemberExpression(requireN, 'a'), m.callExpression(requireN, []));
    function getRequiredModuleDefault(path) {
        const binding = path.scope.getBinding(moduleArg.current.name);
        const declarator = binding?.path.node;
        if (!(declarator && declaratorMatcher.match(declarator))) {
            return;
        }
        const calleeName = declarator.init.callee.name;
        const targetModule = bundle.modules.get(requiredModuleId.current.value.toString());
        if (targetModule && (calleeName === 'require' || calleeName === targetModule.webpackRequire)) {
            return targetModule;
        }
    }
    bundle.modules.forEach((module1)=>{
        traverseDefault(module1.ast, {
            'CallExpression|MemberExpression' (path) {
                if (defaultRequireMatcherAlternative.match(path.node)) {
                    const requiredModule = getRequiredModuleDefault(path);
                    if (requiredModule?.ast.program.sourceType === 'module') {
                        path.replaceWith(buildDefaultAccessGetDefaultExport({
                            OBJECT: moduleArg.current
                        }));
                    } else {
                        path.replaceWith(moduleArg.current);
                    }
                }
            },
            VariableDeclarator (path) {
                if (!defaultRequireMatcher.match(path.node)) {
                    return;
                }
                const requiredModule = getRequiredModuleDefault(path);
                const init = path.get('init');
                if (requiredModule?.ast.program.sourceType === 'module') {
                    init.replaceWith(buildDefaultAccessGetDefaultExport({
                        OBJECT: moduleArg.current
                    }));
                } else {
                    init.replaceWith(moduleArg.current);
                }
                const binding = path.scope.getOwnBinding(getterVarName.current.name);
                binding?.referencePaths.forEach((refPath)=>{
                    if (refPath.parentPath?.isCallExpression() || refPath.parentPath?.isMemberExpression()) {
                        refPath.parentPath.replaceWith(refPath);
                    }
                });
            },
            noScope: true
        });
    });
}
class WebpackBundle extends Bundle {
    constructor(entryId, modules){
        super('webpack', entryId, modules);
    }
    applyTransforms() {
        this.modules.forEach((module1)=>{
            const { webpackRequire } = webpackRequireFunctionMatcher();
            traverseDefault(module1.ast, {
                FunctionDeclaration (path) {
                    if (webpackRequire.match(path.node)) {
                        module1.webpackRequire = path.node.id.name;
                        path.stop();
                    }
                },
                noScope: true
            });
            if (!module1.webpackRequire) module1.webpackRequire = '__webpack_require__';
        });
        this.modules.forEach(inlineVarInjections);
        this.modules.forEach(convertESM);
        convertDefaultRequire(this);
        this.replaceRequirePaths();
    }
    replaceRequirePaths() {
        const requireId = m.capture(m.or(m.numericLiteral(), m.stringLiteral()));
        const requireMatcher = m.callExpression(m.identifierType('Identifier'), [
            requireId
        ]);
        const importId = m.capture(m.stringLiteral());
        const importMatcher = m.importDeclaration(m.anything(), importId);
        this.modules.forEach((module1)=>{
            traverseDefault(module1.ast, {
                'CallExpression|ImportDeclaration': (path)=>{
                    let moduleIdStr;
                    let argPath;
                    let isWebpackRequireCall = false;
                    if (requireMatcher.match(path.node) && (path.node.callee.name === 'require' || path.node.callee.name === module1.webpackRequire)) {
                        moduleIdStr = requireId.current.value.toString();
                        [argPath] = path.get('arguments');
                        isWebpackRequireCall = true;
                    } else if (importMatcher.match(path.node)) {
                        moduleIdStr = importId.current.value;
                        argPath = path.get('source');
                    } else {
                        return;
                    }
                    if (isWebpackRequireCall && !/^\d+$/.test(moduleIdStr) && !/^"\d+"$/.test(moduleIdStr)) {
                        return;
                    }
                    const requiredModule = this.modules.get(moduleIdStr);
                    const replacementPath = relativePath(module1.path, requiredModule?.path ?? `./${moduleIdStr}.js`);
                    argPath.replaceWith(t.stringLiteral(replacementPath));
                    if (!requiredModule) {
                        argPath.addComment('leading', 'webcrack:missing');
                    }
                },
                noScope: true
            });
        });
    }
}
const unpackWebpack4Transform = {
    name: 'unpack-webpack-4',
    tags: [
        'unsafe'
    ],
    scope: true,
    visitor (options = {
        bundle: undefined
    }) {
        const { webpackRequire, containerId } = webpackRequireFunctionMatcher();
        const container = modulesContainerMatcher();
        const matcher = m.callExpression(m.functionExpression(null, [
            containerId
        ], m.blockStatement(anySubList(webpackRequire))), [
            container
        ]);
        return {
            CallExpression (path) {
                if (!matcher.match(path.node)) return;
                path.stop();
                const webpackRequireBinding = path.get('callee').scope.getBinding(webpackRequire.current.id.name);
                const entryId = findAssignedEntryId(webpackRequireBinding) || findRequiredEntryId(webpackRequireBinding);
                const containerPath = path.get(container.currentKeys.join('.'));
                const modules = new Map();
                for (const [id, funcPath] of getModuleFunctions(containerPath)){
                    renameParameters(funcPath, [
                        'module',
                        'exports',
                        'require'
                    ]);
                    const isEntry = id === entryId;
                    const file = t.file(t.program(funcPath.node.body.body));
                    const lastNode = file.program.body.at(-1);
                    if (lastNode?.trailingComments?.some((c)=>c.value.includes("sourceURL=webpack://"))) {
                        lastNode.trailingComments = lastNode.trailingComments.filter((c)=>!c.value.includes("sourceURL=webpack://"));
                        if (lastNode.trailingComments.length === 0) lastNode.trailingComments = null;
                    }
                    modules.set(id, new WebpackModule(id, file, isEntry));
                }
                options.bundle = new WebpackBundle(entryId ?? '', modules);
            }
        };
    }
};
const unpackWebpack5Transform = {
    name: 'unpack-webpack-5',
    tags: [
        'unsafe'
    ],
    scope: true,
    visitor (options = {
        bundle: undefined
    }) {
        const { webpackRequire, containerId } = webpackRequireFunctionMatcher();
        const container = modulesContainerMatcher();
        const matcher = m.blockStatement(anySubList(m.variableDeclaration(undefined, [
            m.variableDeclarator(containerId, container)
        ]), webpackRequire));
        return {
            'BlockStatement|Program' (path) {
                if (!matcher.match(path.node)) return;
                const capturedContainerIdNode = containerId.current;
                const capturedWebpackRequireNode = webpackRequire.current;
                if (!capturedContainerIdNode || !capturedWebpackRequireNode) return;
                const containerBinding = path.scope.getBinding(capturedContainerIdNode.name);
                const webpackRequireBinding = path.scope.getBinding(capturedWebpackRequireNode.id.name);
                if (!containerBinding || !webpackRequireBinding) return;
                if (containerBinding.path.get('init').node !== container.current || webpackRequireBinding.path.node !== webpackRequire.current) {
                    return;
                }
                path.stop();
                const entryId = findAssignedEntryId(webpackRequireBinding);
                const containerPath = containerBinding.path.get('init');
                const modules = new Map();
                for (const [id, funcPath] of getModuleFunctions(containerPath)){
                    renameParameters(funcPath, [
                        'module',
                        'exports',
                        'require'
                    ]);
                    const isEntry = id === entryId;
                    const file = t.file(t.program(funcPath.node.body.body));
                    modules.set(id, new WebpackModule(id, file, isEntry));
                }
                options.bundle = new WebpackBundle(entryId ?? '', modules);
            }
        };
    }
};
const unpackWebpackChunkTransform = {
    name: 'unpack-webpack-chunk',
    tags: [
        'unsafe'
    ],
    scope: true,
    visitor (options = {
        bundle: undefined
    }) {
        const container = modulesContainerMatcher();
        const jsonpGlobal = m.capture(constMemberExpression(m.or(m.identifier(), m.thisExpression()), m.matcher((property)=>typeof property === 'string' && property.startsWith('webpack'))));
        const chunkIds = m.capture(m.arrayOf(m.or(m.numericLiteral(), m.stringLiteral())));
        const matcher = m.callExpression(constMemberExpression(m.assignmentExpression('=', jsonpGlobal, m.logicalExpression('||', m.fromCapture(jsonpGlobal), m.arrayExpression([]))), 'push'), [
            m.arrayExpression(m.anyList(m.arrayExpression(chunkIds), container, m.zeroOrMore()))
        ]);
        return {
            CallExpression (path) {
                if (!matcher.match(path.node)) return;
                path.stop();
                const modules = new Map();
                const containerPath = path.get(container.currentKeys.join('.'));
                for (const [id, funcPath] of getModuleFunctions(containerPath)){
                    renameParameters(funcPath, [
                        'module',
                        'exports',
                        'require'
                    ]);
                    const isEntry = false;
                    const file = t.file(t.program(funcPath.node.body.body));
                    modules.set(id, new WebpackModule(id, file, isEntry));
                }
                options.bundle = new WebpackBundle('', modules);
            }
        };
    }
};
const unpackWebcrackLogger = debugLib('webcrack:unpack');
function unpackAST(ast, mappings = {}) {
    const options = {
        bundle: undefined
    };
    const visitor = visitors.merge([
        unpackWebpack4Transform.visitor(options),
        unpackWebpack5Transform.visitor(options),
        unpackWebpackChunkTransform.visitor(options),
        unpackBrowserifyTransform.visitor(options)
    ]);
    traverseDefault(ast, visitor, undefined, {
        changes: 0
    });
    if (options.bundle) {
        options.bundle.applyMappings(mappings);
        options.bundle.applyTransforms();
        unpackWebcrackLogger(`Bundle: ${options.bundle.type}, modules: ${options.bundle.modules.size}, entry id: ${options.bundle.entryId}`);
    }
    return options.bundle;
}
const DEFAULT_PRAGMA_CANDIDATES_JSX_NEW = [
    'jsx',
    'jsxs',
    '_jsx',
    '_jsxs',
    'jsxDEV',
    'jsxsDEV'
];
const jsxNewTransform = {
    name: 'jsx-new',
    tags: [
        'unsafe'
    ],
    scope: true,
    visitor: ()=>{
        const deepIdentifierMemberExpression = m.memberExpression(m.or(m.identifier(), m.matcher((node)=>deepIdentifierMemberExpression.match(node))), m.identifier(), false);
        const convertibleName = m.or(m.identifier(), m.stringLiteral(), deepIdentifierMemberExpression);
        const typeCapture = m.capture(m.anyExpression());
        const fragmentType = constMemberExpression('React', 'Fragment');
        const propsCapture = m.capture(m.objectExpression());
        const keyCapture = m.capture(m.anyExpression());
        const jsxFunction = m.capture(m.or(...DEFAULT_PRAGMA_CANDIDATES_JSX_NEW));
        const jsxMatcher = m.callExpression(m.or(m.identifier(jsxFunction), m.sequenceExpression([
            m.numericLiteral(0),
            constMemberExpression(m.identifier(), jsxFunction)
        ]), constMemberExpression(m.identifier(), jsxFunction)), m.anyList(typeCapture, propsCapture, m.slice({
            min: 0,
            max: 1,
            matcher: keyCapture
        })));
        function convertTypeJsxNew(typeNode) {
            if (t.isIdentifier(typeNode)) {
                return t.jsxIdentifier(typeNode.name);
            } else if (t.isStringLiteral(typeNode)) {
                return t.jsxIdentifier(typeNode.value);
            } else {
                const object = convertTypeJsxNew(typeNode.object);
                const property = t.jsxIdentifier(typeNode.property.name);
                return t.jsxMemberExpression(object, property);
            }
        }
        function convertAttributesJsxNew(object) {
            const name = m.capture(m.anyString());
            const value = m.capture(m.anyExpression());
            const matcher = m.objectProperty(m.or(m.identifier(name), m.stringLiteral(name)), value);
            return object.properties.flatMap((property)=>{
                if (matcher.match(property)) {
                    if (name.current === 'children') return [];
                    const jsxName = t.jsxIdentifier(name.current);
                    const jsxValue = convertAttributeValueJsxNew(value.current);
                    return t.jsxAttribute(jsxName, jsxValue);
                } else if (t.isSpreadElement(property)) {
                    return t.jsxSpreadAttribute(property.argument);
                } else {
                    throw new Error(`jsx: property type not implemented ${codePreview(object)}`);
                }
            });
        }
        function convertAttributeValueJsxNew(expressionNode) {
            if (expressionNode.type === 'StringLiteral') {
                const hasSpecialChars = /["\\]/.test(expressionNode.value);
                return hasSpecialChars ? t.jsxExpressionContainer(expressionNode) : expressionNode;
            }
            return t.jsxExpressionContainer(expressionNode);
        }
        function convertChildrenJsxNew(object, pragma) {
            const childrenCapture = m.capture(m.anyExpression());
            const matcher = m.objectProperty(m.or(m.identifier('children'), m.stringLiteral('children')), childrenCapture);
            const prop = object.properties.find((p)=>matcher.match(p));
            if (!prop) return [];
            if (pragma.includes('jsxs') && t.isArrayExpression(childrenCapture.current)) {
                return childrenCapture.current.elements.map((child)=>convertChildJsxNew(child));
            }
            return [
                convertChildJsxNew(childrenCapture.current)
            ];
        }
        function convertChildJsxNew(child) {
            if (t.isJSXElement(child)) {
                return child;
            } else if (t.isStringLiteral(child)) {
                const hasSpecialChars = /[{}<>\r\n]/.test(child.value);
                return hasSpecialChars ? t.jsxExpressionContainer(child) : t.jsxText(child.value);
            } else {
                return t.jsxExpressionContainer(child);
            }
        }
        return {
            CallExpression: {
                exit (path) {
                    if (!jsxMatcher.match(path.node)) return;
                    let nameNode;
                    if (convertibleName.match(typeCapture.current)) {
                        nameNode = convertTypeJsxNew(typeCapture.current);
                    } else {
                        nameNode = t.jsxIdentifier(generateUid(path.scope, 'Component'));
                        const componentVar = t.variableDeclaration('const', [
                            t.variableDeclarator(t.identifier(nameNode.name), typeCapture.current)
                        ]);
                        path.getStatementParent()?.insertBefore(componentVar);
                    }
                    const isFragment = fragmentType.match(typeCapture.current);
                    if (t.isIdentifier(typeCapture.current) && /^[a-z]/.test(typeCapture.current.name)) {
                        const binding = path.scope.getBinding(typeCapture.current.name);
                        if (binding && !binding.path.isImportSpecifier() && !binding.path.isImportDefaultSpecifier()) {
                            const newNameForComponent = generateUid(path.scope, 'Component');
                            renameFast(binding, newNameForComponent);
                            nameNode = t.jsxIdentifier(newNameForComponent);
                        }
                    }
                    const attributes = convertAttributesJsxNew(propsCapture.current);
                    if (path.node.arguments.length === 3 && keyCapture.current) {
                        attributes.push(t.jsxAttribute(t.jsxIdentifier('key'), convertAttributeValueJsxNew(keyCapture.current)));
                    }
                    const children = convertChildrenJsxNew(propsCapture.current, jsxFunction.current);
                    let replacementNode;
                    if (isFragment && attributes.length === 0) {
                        const opening = t.jsxOpeningFragment();
                        const closing = t.jsxClosingFragment();
                        replacementNode = t.jsxFragment(opening, closing, children);
                    } else {
                        const selfClosing = children.length === 0;
                        const opening = t.jsxOpeningElement(nameNode, attributes, selfClosing);
                        const closing = selfClosing ? null : t.jsxClosingElement(nameNode);
                        replacementNode = t.jsxElement(opening, closing, children, selfClosing);
                    }
                    path.node.leadingComments = null;
                    path.replaceWith(replacementNode);
                    this.changes++;
                }
            }
        };
    }
};
const jsxTransform = {
    name: 'jsx',
    tags: [
        'unsafe'
    ],
    scope: true,
    visitor: ()=>{
        const deepIdentifierMemberExpression = m.memberExpression(m.or(m.identifier(), m.matcher((node)=>deepIdentifierMemberExpression.match(node))), m.identifier(), false);
        const typeCapture = m.capture(m.or(m.identifier(), m.stringLiteral(), deepIdentifierMemberExpression));
        const propsCapture = m.capture(m.or(m.objectExpression(), m.nullLiteral()));
        const elementMatcher = m.callExpression(constMemberExpression('React', 'createElement'), m.anyList(typeCapture, propsCapture, m.zeroOrMore(m.or(m.anyExpression(), m.spreadElement()))));
        const fragmentMatcher = m.callExpression(constMemberExpression('React', 'createElement'), m.anyList(constMemberExpression('React', 'Fragment'), m.nullLiteral(), m.zeroOrMore(m.or(m.anyExpression(), m.spreadElement()))));
        function convertTypeJsx(typeNode) {
            if (t.isIdentifier(typeNode)) {
                return t.jsxIdentifier(typeNode.name);
            } else if (t.isStringLiteral(typeNode)) {
                return t.jsxIdentifier(typeNode.value);
            } else {
                const object = convertTypeJsx(typeNode.object);
                const property = t.jsxIdentifier(typeNode.property.name);
                return t.jsxMemberExpression(object, property);
            }
        }
        function convertAttributesJsx(object) {
            const name = m.capture(m.anyString());
            const value = m.capture(m.anyExpression());
            const matcher = m.objectProperty(m.or(m.identifier(name), m.stringLiteral(name)), value);
            return object.properties.map((property)=>{
                if (matcher.match(property)) {
                    const jsxName = t.jsxIdentifier(name.current);
                    if (value.current.type === 'StringLiteral') {
                        const hasSpecialChars = /["\\]/.test(value.current.value);
                        const jsxValue = hasSpecialChars ? t.jsxExpressionContainer(value.current) : value.current;
                        return t.jsxAttribute(jsxName, jsxValue);
                    }
                    const jsxValue = t.jsxExpressionContainer(value.current);
                    return t.jsxAttribute(jsxName, jsxValue);
                } else if (t.isSpreadElement(property)) {
                    return t.jsxSpreadAttribute(property.argument);
                } else {
                    throw new Error(`jsx: property type not implemented ${codePreview(object)}`);
                }
            });
        }
        function convertChildrenJsx(children) {
            return children.map((child)=>{
                if (t.isJSXElement(child)) {
                    return child;
                } else if (t.isStringLiteral(child)) {
                    const hasSpecialChars = /[{}<>\r\n]/.test(child.value);
                    return hasSpecialChars ? t.jsxExpressionContainer(child) : t.jsxText(child.value);
                } else if (t.isSpreadElement(child)) {
                    return t.jsxSpreadChild(child.argument);
                } else {
                    return t.jsxExpressionContainer(child);
                }
            });
        }
        return {
            CallExpression: {
                exit (path) {
                    let replacementNode;
                    if (fragmentMatcher.match(path.node)) {
                        const children = convertChildrenJsx(path.node.arguments.slice(2));
                        const opening = t.jsxOpeningFragment();
                        const closing = t.jsxClosingFragment();
                        replacementNode = t.jsxFragment(opening, closing, children);
                    } else if (elementMatcher.match(path.node)) {
                        let nameNode = convertTypeJsx(typeCapture.current);
                        if (t.isIdentifier(typeCapture.current) && /^[a-z]/.test(typeCapture.current.name)) {
                            const binding = path.scope.getBinding(typeCapture.current.name);
                            if (binding && !binding.path.isImportSpecifier() && !binding.path.isImportDefaultSpecifier()) {
                                const newNameForComponent = generateUid(path.scope, 'Component');
                                renameFast(binding, newNameForComponent);
                                nameNode = t.jsxIdentifier(newNameForComponent);
                            }
                        }
                        const attributes = t.isObjectExpression(propsCapture.current) ? convertAttributesJsx(propsCapture.current) : [];
                        const children = convertChildrenJsx(path.node.arguments.slice(2));
                        const selfClosing = children.length === 0;
                        const opening = t.jsxOpeningElement(nameNode, attributes, selfClosing);
                        const closing = selfClosing ? null : t.jsxClosingElement(nameNode);
                        replacementNode = t.jsxElement(opening, closing, children, selfClosing);
                    }
                    if (!replacementNode) {
                        return;
                    }
                    path.node.leadingComments = null;
                    path.replaceWith(replacementNode);
                    this.changes++;
                }
            }
        };
    }
};
const requireMatcherMangle = m.variableDeclarator(m.identifier(), m.callExpression(m.identifier('require'), [
    m.stringLiteral()
]));
function inferNameMangle(path) {
    if (path.parentPath.isClass({
        id: path.node
    })) {
        return generateUid(path.scope, 'C');
    } else if (path.parentPath.isFunction({
        id: path.node
    })) {
        return generateUid(path.scope, 'f');
    } else if (path.listKey === 'params' || path.parentPath.isAssignmentPattern({
        left: path.node
    }) && path.parentPath.listKey === 'params') {
        return generateUid(path.scope, 'p');
    } else if (requireMatcherMangle.match(path.parent)) {
        return generateUid(path.scope, path.parentPath.get('init.arguments.0').node.value);
    } else if (path.parentPath.isVariableDeclarator({
        id: path.node
    })) {
        const init = path.parentPath.get('init');
        const suffix = init.isExpression() && generateExpressionNameMangle(init) || '';
        return generateUid(path.scope, `v${titleCaseMangle(suffix)}`);
    } else if (path.parentPath.isCatchClause()) {
        return generateUid(path.scope, 'e');
    } else if (path.parentPath.isArrayPattern()) {
        return generateUid(path.scope, 'v');
    } else {
        return path.node.name;
    }
}
function generateExpressionNameMangle(expressionPath) {
    if (expressionPath.isIdentifier()) {
        return expressionPath.node.name;
    } else if (expressionPath.isFunctionExpression()) {
        return expressionPath.node.id?.name ?? 'f';
    } else if (expressionPath.isArrowFunctionExpression()) {
        return 'f';
    } else if (expressionPath.isClassExpression()) {
        return expressionPath.node.id?.name ?? 'C';
    } else if (expressionPath.isCallExpression()) {
        return generateExpressionNameMangle(expressionPath.get('callee'));
    } else if (expressionPath.isThisExpression()) {
        return 'this';
    } else if (expressionPath.isNumericLiteral()) {
        return `LN${expressionPath.node.value.toString()}`;
    } else if (expressionPath.isStringLiteral()) {
        return `LS${titleCaseMangle(expressionPath.node.value).slice(0, 20)}`;
    } else if (expressionPath.isObjectExpression()) {
        return 'O';
    } else if (expressionPath.isArrayExpression()) {
        return 'A';
    } else {
        return undefined;
    }
}
function titleCaseMangle(str) {
    return str.replace(/(?:^|\s)([a-z])/g, (_, char)=>char.toUpperCase()).replace(/[^a-zA-Z0-9$_]/g, '');
}
const mangleTransform = {
    name: 'mangle',
    tags: [
        'safe'
    ],
    scope: true,
    visitor (match = ()=>true) {
        return {
            BindingIdentifier: {
                exit (path) {
                    if (path.parentPath.isImportSpecifier() || path.parentPath.isImportDefaultSpecifier() || path.parentPath.isImportNamespaceSpecifier()) return;
                    if (path.parentPath.isObjectProperty() && path.key === 'key' && !path.parentPath.node.computed) return;
                    if ((path.parentPath.isClassMethod() || path.parentPath.isClassProperty()) && path.key === 'key' && !path.parentPath.node.computed) return;
                    if (!match(path.node.name)) return;
                    const binding = path.scope.getBinding(path.node.name);
                    if (!binding) return;
                    if (binding.referencePaths.some((ref)=>ref.getStatementParent()?.isExportNamedDeclaration() || ref.getStatementParent()?.isExportDefaultDeclaration())) return;
                    if (binding.path.parentPath?.isExportNamedDeclaration() || binding.path.parentPath?.isExportDefaultDeclaration()) return;
                    if (binding.scope.isProgramScope() && (t.isFunctionDeclaration(binding.path.parent) || t.isClassDeclaration(binding.path.parent) || t.isVariableDeclarator(binding.path.node) && binding.path.parentPath.parentPath.isProgram())) {}
                    renameFast(binding, inferNameMangle(path));
                    this.changes++;
                }
            }
        };
    }
};
function runPlugins(ast, plugins, state) {
    const pluginObjects = plugins.map((plugin)=>plugin({
            parse,
            types: t,
            traverse: traverseDefault,
            template: templateDefault,
            matchers: m
        }));
    const runPre = async ()=>{
        for (const plugin of pluginObjects){
            await Promise.resolve(plugin.pre?.call(state, state));
        }
    };
    const runPost = async ()=>{
        for (const plugin of pluginObjects){
            await Promise.resolve(plugin.post?.call(state, state));
        }
    };
    return runPre().then(()=>{
        const pluginVisitors = pluginObjects.flatMap((plugin)=>plugin.visitor ?? []);
        if (pluginVisitors.length > 0) {
            const mergedVisitor = visitors.merge(pluginVisitors);
            traverseDefault(ast, mergedVisitor, undefined, state);
        }
        return runPost();
    });
}
const webcrackLogger = debugLib('webcrack:main');
async function webcrack(code, options = {}) {
    const mergedOptions = {
        jsx: true,
        unminify: true,
        unpack: true,
        deobfuscate: true,
        mangle: false,
        plugins: options.plugins ?? {},
        mappings: ()=>({}),
        onProgress: ()=>{},
        sandbox: isBrowser() ? createBrowserSandbox() : createNodeSandbox(),
        ...options
    };
    options = mergedOptions;
    options.onProgress(0);
    if (isBrowser()) {
        debugLib.enable('webcrack:*');
    }
    const isBookmarklet = /^javascript:./.test(code);
    if (isBookmarklet) {
        code = decodeURIComponent(code.replace(/^javascript:/, ''));
    }
    let ast;
    let outputCode = '';
    let bundle;
    const { plugins: customPlugins } = options;
    const state = {
        opts: {}
    };
    const stages = [
        ()=>{
            ast = parse(code, {
                sourceType: 'unambiguous',
                allowReturnOutsideFunction: true,
                errorRecovery: true,
                plugins: [
                    'jsx'
                ]
            });
            if (ast.errors?.length) {
                debugLib('webcrack:parse')('Recovered from parse errors', ast.errors.map((e)=>e.message).join(', '));
            }
        },
        customPlugins.afterParse && (()=>runPlugins(ast, customPlugins.afterParse, state)),
        ()=>{
            applyTransforms(ast, [
                blockStatementsTransform,
                sequenceTransform,
                splitVariableDeclarationsTransform,
                varFunctionsTransform
            ], {
                name: 'prepare'
            });
        },
        customPlugins.afterPrepare && (()=>runPlugins(ast, customPlugins.afterPrepare, state)),
        options.deobfuscate && (()=>applyTransformAsync(ast, deobfuscateMainTransform, options.sandbox)),
        customPlugins.afterDeobfuscate && (()=>runPlugins(ast, customPlugins.afterDeobfuscate, state)),
        options.unminify && (()=>{
            applyTransforms(ast, [
                transpileTransform,
                unminifyTransform
            ]);
        }),
        customPlugins.afterUnminify && (()=>runPlugins(ast, customPlugins.afterUnminify, state)),
        options.mangle && (()=>applyTransform(ast, mangleTransform, typeof options.mangle === 'boolean' ? ()=>true : options.mangle)),
        (options.deobfuscate || options.jsx) && (()=>{
            const transformsToApply = [];
            if (options.deobfuscate) {
                transformsToApply.push(selfDefendingTransform, debugProtectionTransform);
            }
            if (options.jsx) {
                transformsToApply.push(jsxTransform, jsxNewTransform);
            }
            if (transformsToApply.length > 0) {
                applyTransforms(ast, transformsToApply);
            }
        }),
        options.deobfuscate && (()=>applyTransforms(ast, [
                mergeObjectAssignmentsTransform,
                evaluateGlobalsTransform
            ])),
        ()=>outputCode = generate(ast),
        options.unpack && (()=>bundle = unpackAST(ast, options.mappings(m))),
        customPlugins.afterUnpack && (()=>runPlugins(ast, customPlugins.afterUnpack, state))
    ].filter(Boolean);
    for(let i = 0; i < stages.length; i++){
        await stages[i]();
        options.onProgress(100 / stages.length * (i + 1));
    }
    return {
        code: outputCode,
        bundle,
        async save (savePath) {
            const normalizedPath = nodePath.normalize(savePath);
            await nodeMkdir(normalizedPath, {
                recursive: true
            });
            await nodeWriteFile(nodePath.join(normalizedPath, 'deobfuscated.js'), outputCode, 'utf8');
            if (bundle) {
                await bundle.save(normalizedPath);
            }
        }
    };
}
async function runCli() {
    const cliLogger = debugLib('webcrack:cli');
    let packageVersion = 'unknown';
    let packageDescription = 'Deobfuscate and unpack JavaScript code';
    try {
        const __filename1 = nodeURL.fileURLToPath(import.meta.url);
        const __dirname = nodePath.dirname(__filename1);
        const packageJsonPath = nodePath.join(__dirname, '..', 'package.json');
        if (nodeFS.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(nodeFS.readFileSync(packageJsonPath, 'utf8'));
            packageVersion = packageJson.version;
            packageDescription = packageJson.description;
        } else {
            cliLogger("package.json not found at expected location, using default version/description.");
        }
    } catch (e) {
        cliLogger("Error reading package.json: ", e.message);
    }
    debugLib.enable('webcrack:*');
    async function readStdin() {
        let data = '';
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin)data += chunk;
        return data;
    }
    commanderProgram.version(packageVersion).description(packageDescription).option('-o, --output <path>', 'output directory for bundled files').option('-f, --force', 'overwrite output directory').option('-m, --mangle', 'mangle variable names').option('--no-jsx', 'do not decompile JSX').option('--no-unpack', 'do not extract modules from the bundle').option('--no-deobfuscate', 'do not deobfuscate the code').option('--no-unminify', 'do not unminify the code').argument('[file]', 'input file, defaults to stdin').action(async (inputFile)=>{
        const { output: outputDir, force, ...options } = commanderProgram.opts();
        const code = await (inputFile ? nodeReadFile(inputFile, 'utf8') : readStdin());
        if (outputDir) {
            if (force || !nodeFS.existsSync(outputDir)) {
                await nodeRm(outputDir, {
                    recursive: true,
                    force: true
                });
            } else {
                commanderProgram.error('output directory already exists');
            }
        }
        const webcrackOptions = {
            mangle: options.mangle,
            jsx: options.jsx,
            unpack: options.unpack,
            deobfuscate: options.deobfuscate,
            unminify: options.unminify
        };
        const result = await webcrack(code, webcrackOptions);
        if (outputDir) {
            await result.save(outputDir);
            cliLogger(`Output saved to ${outputDir}`);
        } else {
            console.log(result.code);
            if (result.bundle) {
                debugLib('webcrack:unpack')('Modules are not displayed in the terminal. Use the --output option to save them to a directory.');
            }
        }
    });
    await commanderProgram.parseAsync(process.argv);
}
if (require.main === module || typeof process !== 'undefined' && process.argv[1] === (typeof __filename === 'undefined' ? '' : __filename)) {
    runCli().catch((error)=>{
        console.error("CLI Error:", error);
        process.exit(1);
    });
}
module.exports = {
    webcrack,
    createNodeSandbox,
    createBrowserSandbox
};
