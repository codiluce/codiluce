import type { PythonArgument, PythonDefinitionFact, PythonExpression } from '../facts.js';

/** Validate the bounded factory-call profile before evaluating argument values.
 * Expansions/variadics stay opaque; separators and duplicates follow Python. */
export function bindPythonArguments(definition: PythonDefinitionFact, args: PythonArgument[]): Map<string, PythonExpression> | undefined {
  if (args.some(arg => arg.spread) || definition.parameters.some(parameter => parameter.variadic)) return undefined;
  const positional = args.filter(arg => !arg.name), parameters = definition.parameters.filter(parameter => parameter.kind !== 'keyword-only'), supplied = new Map<string, PythonExpression>();
  if (positional.length > parameters.length) return undefined;
  for (const [index, argument] of positional.entries()) supplied.set(parameters[index]!.name, argument.value);
  for (const argument of args.filter(arg => arg.name)) {
    const parameter = definition.parameters.find(parameter => parameter.name === argument.name);
    if (!parameter || parameter.kind === 'positional-only' || supplied.has(argument.name!)) return undefined;
    supplied.set(argument.name!, argument.value);
  }
  if (definition.parameters.some(parameter => !parameter.default && !supplied.has(parameter.name))) return undefined;
  return supplied;
}
