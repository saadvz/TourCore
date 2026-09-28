# Skills

The Tour Core skills live in one place only:
[`/.grok/skills/`](../../.grok/skills/). They use the `SKILL.md` format
(YAML frontmatter: `name`, `description`, `when-to-use`, `allowed-tools`,
`metadata`), so the same files load in Grok Build and other agents that read
`.grok/skills/`, and can be added to a Grok Bot as private skills.

| Skill | File |
| --- | --- |
| Install Tour Core | `.grok/skills/install-tour-core/SKILL.md` |
| Setup Property | `.grok/skills/setup-property/SKILL.md` |
| Map Route | `.grok/skills/map-route/SKILL.md` |
| Run Readiness Check | `.grok/skills/run-readiness-check/SKILL.md` |
| Simulate Tour | `.grok/skills/simulate-tour/SKILL.md` |
| Work Exception | `.grok/skills/work-exception/SKILL.md` |
| Export Audit | `.grok/skills/export-audit/SKILL.md` |

Install Tour Core is the installer skill; the other six are the PRD's operator
skills. They aren't copied here, so there's one source of truth.
`template.json` lists them as part of the template.
