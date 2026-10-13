import type { GradleBuildModel } from './jvm-manifest.js';
import { BOOT35_VERSION, BOOT35_FRAMEWORK_VERSION, BOOT35_KOTLIN_VERSION } from './jvm-spring-boot35.js';

/** Reviewed published Boot 3.5.16/4.0.1/4.0.8 BOM and starter/module POM contracts. These
 * select source analysis defaults; they never resolve/download dependencies or
 * execute a target Gradle plugin. Unlisted coordinates remain unreviewed.
 * https://docs.spring.io/spring-boot/3.5/gradle-plugin/managing-dependencies.html
 * https://docs.spring.io/spring-boot/4.0/gradle-plugin/managing-dependencies.html
 * https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-dependencies/4.0.8/spring-boot-dependencies-4.0.8.pom
 */
export const BOOT_GRADLE_VERSION = '4.0.8';
export const BOOT_FRAMEWORK_VERSION = '7.0.9';
export const BOOT_MANAGEMENT_PLUGIN_VERSION = '1.1.7';
export const BOOT_BOM_COORDINATE = `org.springframework.boot:spring-boot-dependencies:${BOOT_GRADLE_VERSION}`;
const bootPlugin = 'org.springframework.boot', managementPlugin = 'io.spring.dependency-management';
const boot4Starters = new Map<string, string | undefined>([
    ['org.springframework.boot:spring-boot-starter-webmvc', 'spring-webmvc'],
    ['org.springframework.boot:spring-boot-starter-webflux', 'spring-webflux'],
    // WebClient does not establish a reactive server activation profile.
    ['org.springframework.boot:spring-boot-starter-webclient', undefined],
]);
const boot35Starters = new Map<string, string | undefined>([
    ['org.springframework.boot:spring-boot-starter-web', 'spring-webmvc'],
    ['org.springframework.boot:spring-boot-starter-webflux', 'spring-webflux'],
]);
const sourceProfiles: Record<string, { frameworkVersion: string; starters: Map<string, string | undefined>; tests: string[]; managed: Record<string, string> }> = {
    [BOOT35_VERSION]: { frameworkVersion: BOOT35_FRAMEWORK_VERSION, starters: boot35Starters, tests: ['spring-boot-starter-test'], managed: {
        'org.jetbrains.kotlin:kotlin-reflect': BOOT35_KOTLIN_VERSION,
        'org.jetbrains.kotlin:kotlin-test-junit5': BOOT35_KOTLIN_VERSION,
    } },
    '4.0.1': { frameworkVersion: '7.0.2', starters: boot4Starters, tests: ['spring-boot-starter-test','spring-boot-starter-webmvc-test','spring-boot-starter-webflux-test'], managed: {
        'org.jetbrains.kotlin:kotlin-reflect': '2.2.21',
        'org.jetbrains.kotlin:kotlin-test-junit5': '2.2.21',
        'com.fasterxml.jackson.module:jackson-module-kotlin': '2.20.1',
        'org.junit.platform:junit-platform-launcher': '6.0.1',
        'io.projectreactor:reactor-test': '3.8.1',
    } },
    '4.0.8': { frameworkVersion: BOOT_FRAMEWORK_VERSION, starters: boot4Starters, tests: ['spring-boot-starter-test','spring-boot-starter-webmvc-test','spring-boot-starter-webflux-test'], managed: {
        'org.jetbrains.kotlin:kotlin-reflect': '2.2.21',
        'org.jetbrains.kotlin:kotlin-test-junit5': '2.2.21',
    } },
};

export function bootSourceBom(version: string) {
    if (!Object.hasOwn(sourceProfiles, version)) return;
    return { version, coordinate: `org.springframework.boot:spring-boot-dependencies:${version}`, frameworkVersion: sourceProfiles[version]!.frameworkVersion };
}

export function reviewedBootGradlePlugin(id: string): boolean {
    return id === bootPlugin || id === managementPlugin;
}

export function bootGradlePluginGaps(plugins: GradleBuildModel['plugins']): string[] {
    const gaps: string[] = [];
    for (const id of [bootPlugin, managementPlugin]) {
        const selected = plugins.filter(plugin => plugin.id === id);
        if (selected.length > 1) gaps.push(`Competing Gradle plugin declarations require a selected model: ${id}`);
        if (selected.some(plugin => id === bootPlugin ? !plugin.version || !Object.hasOwn(sourceProfiles, plugin.version) : plugin.version !== BOOT_MANAGEMENT_PLUGIN_VERSION)) gaps.push(`Unreviewed Gradle plugin version requires a selected model: ${id}`);
    }
    return gaps;
}

export function bootGradleBom(plugins: GradleBuildModel['plugins']) {
    const boot = plugins.filter(plugin => plugin.id === bootPlugin), management = plugins.filter(plugin => plugin.id === managementPlugin);
    const version = boot[0]?.version, profile = version && Object.hasOwn(sourceProfiles, version) ? sourceProfiles[version] : undefined;
    if (boot.length !== 1 || management.length !== 1 || !profile || management[0]!.version !== BOOT_MANAGEMENT_PLUGIN_VERSION) return;
    return { version: version!, coordinate: `org.springframework.boot:spring-boot-dependencies:${version}`, frameworkVersion: profile.frameworkVersion,
        pluginStart: boot[0]!.start, managementStart: management[0]!.start };
}

export function bootManagedCoordinate(coordinate: string, version = BOOT_GRADLE_VERSION, kotlinVersion?: string): string | undefined {
    if (!Object.hasOwn(sourceProfiles, version)) return;
    const profile = sourceProfiles[version]!, table = profile.managed, managed = Object.hasOwn(table, coordinate) ? table[coordinate] : undefined;
    // The reviewed Boot Kotlin action aligns its kotlin.version property with
    // the selected JVM plugin. The source compiler profile owns that version;
    // Maven and Java-only Gradle retain the exact published BOM defaults.
    if (managed) return `${coordinate}:${coordinate.startsWith('org.jetbrains.kotlin:') && kotlinVersion ? kotlinVersion : managed}`;
    if (profile.starters.has(coordinate) || profile.tests.some(test => coordinate === `org.springframework.boot:${test}`)) return `${coordinate}:${version}`;
}

export function bootDefaultManagedCoordinates(version = BOOT_GRADLE_VERSION): Map<string, string> {
    if (!Object.hasOwn(sourceProfiles, version)) return new Map();
    const keys = [...sourceProfiles[version]!.starters.keys(), ...(version === BOOT35_VERSION ? ['org.springframework.boot:spring-boot-starter-test'] : [])];
    return new Map(keys.map(key => [key, `${key}:${version}`]));
}

export function bootStarterFrameworkModule(coordinate: string, selectedVersion = BOOT_GRADLE_VERSION): string | undefined {
    const parts = coordinate.split(':');
    if (parts.length !== 3 || parts[2] !== selectedVersion || !Object.hasOwn(sourceProfiles, selectedVersion)) return;
    const module = sourceProfiles[selectedVersion]!.starters.get(parts.slice(0, 2).join(':'));
    return module ? `org.springframework:${module}:${sourceProfiles[selectedVersion]!.frameworkVersion}` : undefined;
}

export function bootStarterVersionMismatch(coordinate: string, selectedVersion = BOOT_GRADLE_VERSION): boolean {
    const parts = coordinate.split(':');
    return parts.length === 3 && Object.hasOwn(sourceProfiles, selectedVersion) && sourceProfiles[selectedVersion]!.starters.has(parts.slice(0, 2).join(':')) && parts[2] !== selectedVersion;
}
