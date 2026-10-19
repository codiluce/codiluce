# Project communication checklist

Use this checklist for feature additions, changes or removals and changes to Codiluce's goals or positioning. It can also be requested explicitly for a broader review. Review once per coherent change; revisit it if later edits change the public behavior or message.

## Establish what changed

- Identify the affected behavior, goal, audience or claim, including changed commands, requirements, defaults and limitations.
- Distinguish what is available in the published npm version, what is implemented only on `main`, and what is still planned. A goal or roadmap decision is not a delivered feature.

## Review the public surfaces

Check each surface for content affected by the change, updating only what needs to change:

- **Landing page:** `site/app/page.tsx` and the relevant components and data in `site/components/` and `site/lib/`. Check the headline, goal, feature claims, installation examples and demos where relevant.
- **codiluce.com docs:** relevant pages under `site/app/docs/`, with navigation, install commands and release markers in `site/lib/site.ts`. Follow links to related guides under `docs/` when those guides describe the changed behavior.
- **GitHub README:** root `README.md`, including positioning, features, setup examples, requirements and limitations.
- **npm README:** root `README.md` is also the package README. Review it for someone installing the published package, including whether examples and linked images or docs work from npm.
- **npm description:** the root `package.json` `description`; review `keywords` too when capabilities or positioning change.
- **Metadata:** site title and meta description, Open Graph and Twitter fields in `site/app/layout.tsx`, plus page-specific metadata in `site/app/docs/**/page.tsx`. Review social preview text and imagery when the message changes; the generator is `site/scripts/social-preview.mjs`.

## Keep the information consistent

- Match claims and instructions across affected surfaces while adapting detail to each audience. Short descriptions do not need to list every feature.
- Remove stale names, commands, promises and limitations. Preserve qualifications for partial or experimental capabilities.
- Use the existing `NEXT_RELEASE` / `NextTag` convention for features implemented on `main` but absent from the npm release. Do not imply that `npx codiluce@latest` includes them. Keep planned work labelled as planned.
- Search for the specific old terms or claims involved in the change to catch duplicate copy. A full project-wide content audit is only needed when the scope warrants it, such as a positioning change.

## Verify and finish

- Check changed examples, links and release claims against the implementation and intended version. Run the relevant site checks if website source changes, following `site/AGENTS.md`; metadata-only and README edits do not require application tests.
- Briefly mention communication updates in the task's completion summary, or say that the review found no affected public content. Do not create a separate report for this checklist.
- Updating source files does not deploy codiluce.com or update the published npm package. Report any remaining deployment or publication step, and perform it only when authorized by the task. Do not create an npm release solely to refresh copy.
