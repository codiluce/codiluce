import type { GradleBuildModel } from './jvm-manifest.js';

/** Reviewed published Boot 4.0.8 BOM and starter/module POM contracts. These
 * select source analysis defaults; they never resolve/download dependencies or
 * execute a target Gradle plugin. Unlisted coordinates remain unreviewed.
 * https://docs.spring.io/spring-boot/4.0/gradle-plugin/managing-dependencies.html
 * https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-dependencies/4.0.8/spring-boot-dependencies-4.0.8.pom
 */
export const BOOT_GRADLE_VERSION = '4.0.8';
export const BOOT_FRAMEWORK_VERSION = '7.0.9';
export const BOOT_MANAGEMENT_PLUGIN_VERSION = '1.1.7';
export const BOOT_BOM_COORDINATE = `org.springframework.boot:spring-boot-dependencies:${BOOT_GRADLE_VERSION}`;
const bootPlugin = 'org.springframework.boot', managementPlugin = 'io.spring.dependency-management';
const starters = new Map<string, string | undefined>([
    ['org.springframework.boot:spring-boot-starter-webmvc', 'spring-webmvc'],
    ['org.springframework.boot:spring-boot-starter-webflux', 'spring-webflux'],
    // WebClient does not establish a reactive server activation profile.
    ['org.springframework.boot:spring-boot-starter-webclient', undefined],
]);

export function reviewedBootGradlePlugin(id: string): boolean {
    return id === bootPlugin || id === managementPlugin;
}

export function bootGradlePluginGaps(plugins: GradleBuildModel['plugins']): string[] {
    const gaps: string[] = [];
    for (const [id, version] of [[bootPlugin, BOOT_GRADLE_VERSION], [managementPlugin, BOOT_MANAGEMENT_PLUGIN_VERSION]]) {
        const selected = plugins.filter(plugin => plugin.id === id);
        if (selected.length > 1) gaps.push(`Competing Gradle plugin declarations require a selected model: ${id}`);
        if (selected.some(plugin => plugin.version !== version)) gaps.push(`Unreviewed Gradle plugin version requires a selected model: ${id}`);
    }
    return gaps;
}

export function bootGradleBom(plugins: GradleBuildModel['plugins']) {
    const boot = plugins.filter(plugin => plugin.id === bootPlugin), management = plugins.filter(plugin => plugin.id === managementPlugin);
    if (boot.length !== 1 || management.length !== 1 || boot[0]!.version !== BOOT_GRADLE_VERSION || management[0]!.version !== BOOT_MANAGEMENT_PLUGIN_VERSION) return;
    return { coordinate: BOOT_BOM_COORDINATE, frameworkVersion: BOOT_FRAMEWORK_VERSION,
        pluginStart: boot[0]!.start, managementStart: management[0]!.start };
}

export function bootManagedCoordinate(coordinate: string): string | undefined {
    return starters.has(coordinate) ? `${coordinate}:${BOOT_GRADLE_VERSION}` : undefined;
}

export function bootStarterFrameworkModule(coordinate: string): string | undefined {
    const parts = coordinate.split(':');
    if (parts.length !== 3 || parts[2] !== BOOT_GRADLE_VERSION) return;
    const module = starters.get(parts.slice(0, 2).join(':'));
    return module ? `org.springframework:${module}:${BOOT_FRAMEWORK_VERSION}` : undefined;
}

export function bootStarterVersionMismatch(coordinate: string): boolean {
    const parts = coordinate.split(':');
    return parts.length === 3 && starters.has(parts.slice(0, 2).join(':')) && parts[2] !== BOOT_GRADLE_VERSION;
}
