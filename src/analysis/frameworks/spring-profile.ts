import type { AnalysisContext } from '../../core/analyzer.js';
import type { ApplicationConfig, SpringMvcConfig } from '../../core/config.js';
import { evidence, type Evidence } from '../../core/graph.js';
import type { JvmProjects, JvmProject } from '../resolution/jvm-projects.js';
import path from 'node:path';
import { parseDocument } from 'yaml';
export const SPRING_VERSION = '1';
export interface SpringMvcProfile { version?: string; bootVersion?: string; dialect?: 'spring-path-6.2' | 'spring-path-7.0'; config: SpringMvcConfig; proof: Evidence[]; gaps: string[] }
/** Declared/recorded dependency identities only. No BOM/JAR download, dependency
 * resolution or target build runs; unavailable mediation remains a gap. */
export function springMvcProfile(context: AnalysisContext, projects: JvmProjects, project: JvmProject, app: ApplicationConfig): SpringMvcProfile {
  const config = { ...app.jvm?.spring }, classpath = projects.classpath(project), profile: SpringMvcProfile = { config, proof: [], gaps: [...classpath.gaps] };
  const dependencies = classpath.artifacts;
  const mvc = dependencies.filter(dep => dep.coordinate?.startsWith('org.springframework:spring-webmvc:'));
  const boot = dependencies.filter(dep => /^org\.springframework\.boot:spring-boot-starter-(?:web|webmvc):/.test(dep.coordinate ?? ''));
  const frameworks = dependencies.filter(dep => dep.coordinate?.startsWith('org.springframework:'));
  const declared = [...new Set(mvc.map(dep => dep.coordinate!.split(':')[2]!))], boots = [...new Set(boot.map(dep => dep.coordinate!.split(':')[2]!))];
  profile.version = config.version ?? (declared.length === 1 ? declared[0] : undefined);
  profile.bootVersion = config.bootVersion ?? (boots.length === 1 ? boots[0] : undefined);
  if (declared.length > 1 || boots.length > 1 || config.version && declared.some(version => version !== config.version) || config.bootVersion && boots.some(version => version !== config.bootVersion)) profile.gaps.push('Competing recorded/declared Spring MVC dependency versions');
  if (!mvc.length && !boot.length && !config.version) profile.gaps.push('No declared or recorded Spring MVC dependency profile');
  if (!profile.version) profile.gaps.push('Spring Framework version is unavailable; a Boot starter alone does not prove the transitive BOM version');
  else if (/^6\.2\.\d+$/.test(profile.version)) profile.dialect = 'spring-path-6.2';
  else if (/^7\.0\.\d+$/.test(profile.version)) profile.dialect = 'spring-path-7.0';
  else profile.gaps.push('Spring MVC version is outside the reviewed 6.2/7.0 families');
  if (profile.bootVersion && !/^(?:3\.5|4\.0)\.\d+$/.test(profile.bootVersion)) profile.gaps.push('Spring Boot version is outside the reviewed 3.5/4.0 families');
  if (profile.bootVersion && profile.version && (profile.bootVersion.startsWith('3.5.') !== profile.version.startsWith('6.2.'))) profile.gaps.push('Recorded Spring Boot/Framework families are incompatible');
  if (frameworks.some(dep => dep.coordinate!.split(':')[2] !== profile.version)) profile.gaps.push('Spring Framework modules have competing declared versions');
  if (config.matchingStrategy === 'ant') profile.gaps.push('AntPathMatcher requires a separate reviewed routing profile');
  const properties = new Map<string,{value:string;file:string;line:number}>(), keys = ['server.servlet.context-path','spring.mvc.servlet.path','spring.mvc.pathmatch.matching-strategy'];
  const directory = path.posix.join(project.root,'src/main/resources');
  for (const file of [...new Set([...context.files.keys(),...context.fileInventory??[]])].filter(file => file.startsWith(directory+'/') && /^application(?:-[^.]+)?\.(?:properties|ya?ml)$/.test(path.posix.basename(file)))) {
    if (/^application-/.test(path.posix.basename(file))) { profile.gaps.push('Unselected profile-specific Spring runtime properties'); continue; }
    const text = context.sources?.readFile(file);
    if (text === undefined) { profile.gaps.push('Indexed Spring runtime properties are denied/unavailable'); continue; }
    if (file.endsWith('.properties')) {
      for (const [index,line] of text.split(/\r?\n/).entries()) {
        if (!line.trim() || /^\s*[#!]/.test(line)) continue;
        const pair = /^\s*([^\s=:]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
        if (!pair || /\\/.test(line)) { profile.gaps.push('Escaped/continued Spring properties require a reviewed property-source reader'); continue; }
        if (keys.includes(pair[1]!)) { if (properties.has(pair[1]!)) profile.gaps.push('Competing Spring runtime property sources'); properties.set(pair[1]!,{value:pair[2]!,file,line:index+1}); }
        else if (/^(?:spring\.profiles\.|spring\.config\.|spring\.autoconfigure\.exclude|spring\.mvc\.)/.test(pair[1]!)) profile.gaps.push(`Unreviewed Spring runtime routing/profile property ${pair[1]}`);
      }
    } else {
      // The YAML library parses data with bounded aliases, without executing
      // constructors/custom tags or target configuration.
      try {
        const document = parseDocument(text,{strict:true,uniqueKeys:true});
        if (document.errors.length || document.warnings.length) throw new Error('Unsupported Spring YAML document');
        const value = document.toJS({maxAliasCount:32}), flatten = (object:unknown,prefix='',depth=0):void => {
          if(depth>16)throw new Error('Spring YAML nesting budget');
          if(!object||typeof object!=='object'||Array.isArray(object))return;
          for(const[key,item]of Object.entries(object)){const name=prefix?prefix+'.'+key:key;if(item&&typeof item==='object')flatten(item,name,depth+1);else if(keys.includes(name)){if(typeof item!=='string'||properties.has(name))throw new Error('Opaque/competing Spring YAML property');properties.set(name,{value:item,file,line:1});}else if(/^(?:spring\.profiles\.|spring\.config\.|spring\.autoconfigure\.exclude|spring\.mvc\.)/.test(name))profile.gaps.push(`Unreviewed Spring runtime routing/profile property ${name}`);}
        };flatten(value);
      } catch { profile.gaps.push('Opaque/multiple-document/aliased Spring YAML property sources'); }
    }
  }
  for (const [key,field] of [['server.servlet.context-path','contextPath'],['spring.mvc.servlet.path','servletPath'],['spring.mvc.pathmatch.matching-strategy','matchingStrategy']] as const) {
    const property=properties.get(key);if(!property)continue;
    profile.proof.push({...evidence('framework','spring-mvc',property.file,property.line,`Original literal Spring runtime property ${key}`),analyzerVersion:SPRING_VERSION});
    if(config[field]!==undefined)continue;
    if(field==='matchingStrategy') { if(!['path_pattern_parser','ant_path_matcher'].includes(property.value))profile.gaps.push('Unreviewed Spring path matching strategy'); else config.matchingStrategy=property.value==='ant_path_matcher'?'ant':'path-pattern'; }
    else if(property.value==='/'||property.value==='')config[field]='';
    else if(property.value.startsWith('/')&&!property.value.endsWith('/')&&!/[\\\0?#{}*;]/.test(property.value)&&!property.value.includes('//')&&!property.value.split('/').some(segment=>segment==='.'||segment==='..'))config[field]=property.value;
    else profile.gaps.push(`Opaque/invalid Spring servlet property ${key}`);
  }
  if(config.matchingStrategy==='ant')profile.gaps.push('AntPathMatcher requires a separate reviewed routing profile');
  if(profile.bootVersion&&config.servletPath)profile.gaps.push('Nondefault Boot DispatcherServlet path requires a reviewed servlet/PathPattern registration profile');
  profile.proof.push(...[...mvc, ...boot].flatMap(dep => dep.proof));
  if (app.jvm?.spring) profile.proof.push({ ...evidence('framework','spring-mvc',undefined,undefined,`Recorded Spring MVC compilation/servlet/registration inputs for ${app.name}`), analyzerVersion: SPRING_VERSION });
  profile.gaps = [...new Set(profile.gaps)];
  return profile;
}
