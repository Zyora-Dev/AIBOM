import { parser as pythonParser } from '@lezer/python';
import { parse as parseJavaScript } from '@babel/parser';

const unresolved = () => ({ state: 'dynamic', value: null });
const absent = () => ({ state: 'absent', value: null });
const literal = value => ({ state: 'literal', value });
const children = node => {
  const result = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
};

export function analyzeSource(path, source) {
  const events = [];
  const issues = [];
  const aliases = new Map();
  const line = offset => source.slice(0, offset).split('\n').length;
  const qualify = name => {
    const parts = name.split('.');
    return [aliases.get(parts[0]) || parts[0], ...parts.slice(1)].join('.');
  };
  const emitCall = (name, args, options, offset) => {
    const fullName = qualify(name);
    const tail = fullName.split('.').at(-1);
    const evidence = { path, line: line(offset), confidence: 'medium', call: fullName };
    const option = key => options.has('*') ? unresolved() : options.get(key) || absent();
    if (tail === 'from_pretrained' || tail === 'load_dataset' || tail === 'pipeline') {
      const kind = tail === 'load_dataset' ? 'dataset' : 'model';
      const ref = tail === 'pipeline' ? (options.get('model') || args[1] || absent()) : (args[0] || options.get('pretrained_model_name_or_path') || options.get('path') || absent());
      events.push({ ...evidence, kind, name: ref.state === 'literal' && typeof ref.value === 'string' ? ref.value : null, referenceState: ref.state, revision: option('revision'), remoteCode: option('trust_remote_code'), ecosystem: 'huggingface' });
    } else if (/^(?:torch\.load|pickle\.(?:load|loads)|joblib\.load)$/.test(fullName)) {
      events.push({ ...evidence, kind: 'loader', name: fullName, weightsOnly: option('weights_only') });
    } else if (/\.(?:create|generate|invoke)$/.test(fullName) && options.has('model')) {
      const ref = options.get('model');
      events.push({ ...evidence, kind: 'model', name: ref.state === 'literal' && typeof ref.value === 'string' ? ref.value : null, referenceState: ref.state, revision: absent(), remoteCode: absent(), ecosystem: 'unspecified' });
    }
  };

  if (path.endsWith('.py')) {
    const tree = pythonParser.parse(source);
    let error = false;
    tree.iterate({ enter(node) { if (node.type.isError) error = true; } });
    if (error) return { events: [], issues: [{ code: 'PARSE_ERROR', path, line: 1, message: 'Python syntax could not be fully parsed; this file was not analyzed.' }] };
    const text = node => source.slice(node.from, node.to);
    const value = node => {
      if (!node) return absent();
      if (node.name === 'Boolean') return literal(text(node) === 'True');
      if (node.name === 'String') {
        const raw = text(node);
        const match = raw.match(/^(?:r|u)?(['"])([^\r\n]*)\1$/i);
        if (match && !match[2].includes('\\') && !raw.startsWith('"""') && !raw.startsWith("'''")) return literal(match[2]);
      }
      return unresolved();
    };
    tree.iterate({ enter(ref) {
      if (ref.name !== 'ImportStatement') return;
      const statement = text(ref.node);
      const from = statement.match(/^from\s+([\w.]+)\s+import\s+(.+)$/s);
      const imports = from ? from[2] : statement.replace(/^import\s+/, '');
      for (const part of imports.replace(/[()]/g, '').split(',')) {
        const match = part.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/);
        if (!match) continue;
        aliases.set(match[2] || match[1].split('.')[0], from ? `${from[1]}.${match[1]}` : match[1]);
      }
    } });
    tree.iterate({ enter(ref) {
      const node = ref.node;
      if (node.name === 'CallExpression') {
        const parts = children(node);
        const name = text(parts[0]);
        if (!/^[\w.]+$/.test(name)) return;
        const argList = parts.find(n => n.name === 'ArgList');
        if (!argList) return;
        const groups = [];
        let group = [];
        for (const child of children(argList).slice(1, -1)) {
          if (child.name === ',') { groups.push(group); group = []; }
          else group.push(child);
        }
        if (group.length) groups.push(group);
        const args = [], options = new Map();
        for (const items of groups) {
          if (items[0]?.name === 'VariableName' && items[1]?.name === 'AssignOp') options.set(text(items[0]), items.length === 3 ? value(items[2]) : unresolved());
          else if (items.some(n => text(n) === '**' || text(n) === '*')) options.set('*', unresolved());
          else args.push(items.length === 1 ? value(items[0]) : unresolved());
        }
        emitCall(name, args, options, node.from);
      } else if (node.name === 'AssignStatement') {
        const parts = children(node);
        if (parts.length === 3 && text(parts[0]) === 'model' && parts[1].name === 'AssignOp' && value(parts[2]).state === 'literal' && typeof value(parts[2]).value === 'string') {
          events.push({ kind: 'model', name: value(parts[2]).value, referenceState: 'literal', ecosystem: 'unspecified', path, line: line(node.from), revision: absent(), remoteCode: absent(), confidence: 'low', call: 'model assignment (candidate)' });
        }
      }
    } });
  } else {
    let ast;
    try {
      ast = parseJavaScript(source, { sourceType: 'unambiguous', plugins: [...(/\.(?:ts|tsx)$/.test(path) ? ['typescript'] : []), ...(/\.(?:jsx|tsx)$/.test(path) ? ['jsx'] : [])] });
    } catch (error) {
      return { events: [], issues: [{ code: 'PARSE_ERROR', path, line: error.loc?.line || 1, message: 'JavaScript/TypeScript syntax could not be parsed; this file was not analyzed.' }] };
    }
    const walk = (node, visit) => {
      if (!node || typeof node !== 'object') return;
      if (node.type) visit(node);
      for (const [key, val] of Object.entries(node)) {
        if (['loc', 'tokens', 'comments', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue;
        if (Array.isArray(val)) val.forEach(child => walk(child, visit));
        else if (val && typeof val === 'object') walk(val, visit);
      }
    };
    const name = node => node?.type === 'Identifier' ? node.name : ['MemberExpression', 'OptionalMemberExpression'].includes(node?.type) && !node.computed ? `${name(node.object)}.${name(node.property)}` : '';
    const value = node => ['StringLiteral', 'BooleanLiteral', 'NumericLiteral'].includes(node?.type) ? literal(node.value) : node ? unresolved() : absent();
    walk(ast, node => {
      if (node.type !== 'ImportDeclaration') return;
      for (const specifier of node.specifiers) aliases.set(specifier.local.name, `${node.source.value}.${specifier.imported?.name || ''}`.replace(/\.$/, ''));
    });
    walk(ast, node => {
      if (['CallExpression', 'OptionalCallExpression'].includes(node.type)) {
        const options = new Map();
        for (const arg of node.arguments) {
          if (arg.type === 'SpreadElement') options.set('*', unresolved());
          if (arg.type !== 'ObjectExpression') continue;
          for (const property of arg.properties) {
            if (property.type === 'ObjectProperty' && !property.computed) options.set(property.key.name || property.key.value, value(property.value));
            else options.set('*', unresolved());
          }
        }
        const callName = name(node.callee);
        const tail = callName.split('.').at(-1);
        const optionsIndex = tail === 'pipeline' ? 2 : 1;
        if (['from_pretrained', 'load_dataset', 'pipeline'].includes(tail) && node.arguments[optionsIndex] && node.arguments[optionsIndex].type !== 'ObjectExpression') options.set('*', unresolved());
        emitCall(callName, node.arguments.map(value), options, node.start);
      } else if (node.type === 'VariableDeclarator' && node.id?.name === 'model' && node.init?.type === 'StringLiteral') {
        events.push({ kind: 'model', name: node.init.value, referenceState: 'literal', ecosystem: 'unspecified', path, line: line(node.start), revision: absent(), remoteCode: absent(), confidence: 'low', call: 'model assignment (candidate)' });
      }
    });
  }
  return { events, issues };
}
