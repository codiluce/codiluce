import type { GradleCompilerInputs } from './jvm-gradle-compiler.js';
import type { JvmSemanticFacts } from '../facts.js';

/** Pinned published Kotlin 2.2.21 source contracts. Neither compiler nor
 * Gradle/compiler plugins execute; generated declarations remain unverified.
 * Kotlin v2.2.21: AllOpenPluginNames, FirAllOpenStatusTransformer and
 * AnnotationDefaultTargetMode. Spring preset follows source/meta annotations
 * and supertypes, preserving explicit modality and local callable boundaries.
 */
export const KOTLIN_COMPILER_VERSION = '2.2.21';
export const KOTLIN_SPRING_PLUGIN = 'org.jetbrains.kotlin.plugin.spring';
const jvmPlugin = 'org.jetbrains.kotlin.jvm';
export const KOTLIN_SPRING_PRESETS = new Set([
    'org.springframework.stereotype.Component',
    'org.springframework.transaction.annotation.Transactional',
    'org.springframework.scheduling.annotation.Async',
    'org.springframework.cache.annotation.Cacheable',
    'org.springframework.boot.test.context.SpringBootTest',
    'org.springframework.validation.annotation.Validated',
]);
// Published Framework 7.0.2/7.0.9 and Boot 4.0.1/4.0.8 annotation chains.
// Local declarations must use their actual source annotations instead.
export const KOTLIN_SPRING_COMPONENT_META = new Set([
    'org.springframework.stereotype.Controller',
    'org.springframework.stereotype.Service',
    'org.springframework.stereotype.Repository',
    'org.springframework.context.annotation.Configuration',
    'org.springframework.web.bind.annotation.RestController',
    'org.springframework.boot.SpringBootConfiguration',
    'org.springframework.boot.autoconfigure.SpringBootApplication',
]);
export interface KotlinCompilerProfile {
    version: '2.2.21';
    springAllOpen: boolean;
    effectiveArguments: { value: string; start: number }[];
    annotationDefaultTarget?: 'param-property';
    jsr305?: 'strict' | 'warn' | 'ignore';
    javaParameters: boolean;
    jvmPluginStart: number;
    springPluginStart?: number;
}
export function readKotlinCompilerProfile(plugins: { id: string; version?: string; start: number }[], updates: GradleCompilerInputs['kotlinArgumentUpdates']): { profile?: KotlinCompilerProfile; gaps: string[] } {
    const jvm = plugins.filter(plugin => plugin.id === jvmPlugin), spring = plugins.filter(plugin => plugin.id === KOTLIN_SPRING_PLUGIN), gaps: string[] = [];
    let effective: KotlinCompilerProfile['effectiveArguments'] = [];
    for (const update of updates) effective = update.operation === 'set' ? [...update.arguments] : [...effective, ...update.arguments];
    if (jvm.length > 1) gaps.push('Competing Kotlin JVM plugin declarations require a selected compiler model');
    if (spring.length > 1) gaps.push('Competing Kotlin Spring plugin declarations require a selected compiler model');
    const pinned = jvm.length === 1 && jvm[0]!.version === KOTLIN_COMPILER_VERSION;
    if (spring.length && (!pinned || spring.some(plugin => plugin.version !== KOTLIN_COMPILER_VERSION))) gaps.push('Unreviewed org.jetbrains.kotlin.plugin.spring compiler/version selection');
    const paramProperty = effective.some(argument => argument.value === '-Xannotation-default-target=param-property');
    if (paramProperty && !pinned) gaps.push('Kotlin annotation default-target transformation requires the pinned reviewed compiler profile');
    const nullability = new Set(effective.filter(argument => argument.value.startsWith('-Xjsr305=')).map(argument => argument.value.slice('-Xjsr305='.length)));
    if (nullability.size > 1) gaps.push('Competing Kotlin JSR-305 compiler inputs require a selected compiler profile');
    if (!pinned || gaps.length) return { gaps };
    return { gaps, profile: { version: KOTLIN_COMPILER_VERSION, springAllOpen: spring.length === 1, effectiveArguments: effective,
        ...paramProperty ? { annotationDefaultTarget: 'param-property' as const } : {},
        ...nullability.size === 1 ? { jsr305: [...nullability][0] as 'strict' | 'warn' | 'ignore' } : {},
        javaParameters: effective.some(argument => argument.value === '-java-parameters'), jvmPluginStart: jvm[0]!.start,
        ...spring.length ? { springPluginStart: spring[0]!.start } : {} } };
}

/** Preserve original constructor/property facts instead of inventing bytecode
 * fields/accessors or pretending an unknown annotation target is selected. */
export function kotlinAnnotationPlacementGap(facts: JvmSemanticFacts | undefined): string | undefined {
    if (facts?.definitions.some(definition => definition.parameters.some(parameter => parameter.property && parameter.annotations.some(annotation => !annotation.target))
        || definition.kind === 'property' && definition.annotations.some(annotation => !annotation.target)))
        return 'Original annotated Kotlin properties require reviewed annotation-target/metadata placement; generated fields/accessors are not inferred';
}
