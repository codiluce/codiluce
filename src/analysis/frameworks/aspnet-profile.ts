import type { AnalysisContext } from '../../core/analyzer.js';
import type { ApplicationConfig } from '../../core/config.js';
import { evidence, type Evidence } from '../../core/graph.js';
import type { DotnetProject } from '../resolution/dotnet-projects.js';
export const ASPNET_VERSION = '2';
export interface AspNetProfile {
    major?: 8 | 9 | 10;
    version?: string;
    pathBase: string;
    implicitUsings: boolean;
    proof: Evidence[];
    gaps: string[];
}
/** Indexed SDK/TFM/FrameworkReference or explicitly recorded deployment
 * family. No installed SDK, restored binary, environment or build is queried. */
export function aspNetProfile(context: AnalysisContext, project: DotnetProject, app: ApplicationConfig): AspNetProfile {
    const config = app.dotnet?.aspnet, profile: AspNetProfile = { pathBase: config?.pathBase ?? '', implicitUsings: false, proof: [...project.proof], gaps: [] }, target = /^net(8|9|10)\.0$/.exec(project.targetFramework ?? '');
    const references = project.dependencies.filter(dependency => dependency.name === 'Microsoft.AspNetCore.App');
    const available = project.sdk === 'Microsoft.NET.Sdk.Web' && project.properties.disableimplicitframeworkreferences?.toLowerCase() !== 'true' || references.some(reference => reference.kind === 'FrameworkReference');
    if (target)
        profile.major = Number(target[1]) as 8 | 9 | 10;
    else if (project.targetFramework || !config?.version)
        profile.gaps.push('ASP.NET source target is outside the reviewed bare .NET 8/9/10 families');
    if (project.properties.disableimplicitframeworkreferences?.toLowerCase() === 'true' && !references.some(reference => reference.kind === 'FrameworkReference'))
        profile.gaps.push('Original project disables the implicit ASP.NET framework reference');
    if (!available && !config?.version)
        profile.gaps.push('No indexed Web SDK, ASP.NET FrameworkReference or recorded framework version');
    const declarations = [config?.version, project.properties.aspnetcoreappversion].filter((value): value is string => !!value);
    if (declarations.length && new Set(declarations).size !== 1)
        profile.gaps.push('Recorded/declarative ASP.NET runtime versions compete');
    profile.version = declarations[0];
    if (profile.version) {
        const selected = /^(8|9|10)\.0\.\d+$/.exec(profile.version);
        if (!selected || target && Number(selected[1]) !== Number(target[1]))
            profile.gaps.push('ASP.NET runtime version and target family are unreviewed/incompatible');
        else if (!profile.major)
            profile.major = Number(selected[1]) as 8 | 9 | 10;
    }
    if (config)
        profile.proof.push({ ...evidence('framework', 'aspnet', project.id, undefined, 'Recorded applications[].dotnet.aspnet deployment inputs'), analyzerVersion: ASPNET_VERSION });
    if (references.some(reference => reference.kind !== 'FrameworkReference' || reference.version))
        profile.gaps.push('Explicit binary ASP.NET packages/version negotiation requires a reviewed dependency profile');
    if (project.properties.disableimplicitframeworkreferences && !['true', 'false'].includes(project.properties.disableimplicitframeworkreferences.toLowerCase()))
        profile.gaps.push('Implicit framework references have an opaque selection');
    profile.implicitUsings = project.sdk === 'Microsoft.NET.Sdk.Web' && ['true', 'enable'].includes(project.properties.implicitusings?.toLowerCase() ?? '');
    if (profile.implicitUsings)
        profile.proof.push({ ...evidence('framework', 'aspnet', project.id, undefined, 'Reviewed Web SDK implicit using profile under original ImplicitUsings selection; no generated source is fabricated'), analyzerVersion: ASPNET_VERSION });
    const environment = context.csharp?.projects.classpath(project);
    profile.gaps.push(...environment?.gaps ?? project.blockers);
    if ((environment?.projects ?? [project]).some(item => item.dependencies.some(dependency => dependency.kind !== 'FrameworkReference' || dependency.name !== 'Microsoft.AspNetCore.App')))
        profile.gaps.push('Unreviewed binary dependency can supply competing extensions or routing/metadata policies');
    return profile;
}
