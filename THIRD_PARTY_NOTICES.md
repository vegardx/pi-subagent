# Third-party notices

`pi-subagent` depends on the following separately distributed packages. Their
licenses apply to those packages; the project itself remains MIT licensed.

| Package | Qualified version | License | Source |
| --- | ---: | --- | --- |
| `@earendil-works/gondolin` | 0.12.0 | Apache-2.0 | <https://github.com/earendil-works/gondolin> |
| `ajv` | 8.20.0 | MIT | <https://github.com/ajv-validator/ajv> |
| `yaml` | 2.9.0 | ISC | <https://github.com/eemeli/yaml> |
| `typebox` | 1.3.14 | MIT | <https://github.com/sinclairzx81/typebox> |
| `@earendil-works/pi-agent-core` | 0.84.2 | MIT | <https://github.com/earendil-works/pi> |
| `@earendil-works/pi-ai` | 0.84.2 | MIT | <https://github.com/earendil-works/pi> |
| `@earendil-works/pi-coding-agent` | 0.84.2 | MIT | <https://github.com/earendil-works/pi> |
| `@earendil-works/pi-tui` | 0.84.2 | MIT | <https://github.com/earendil-works/pi> |

The Apache License 2.0 text required by Gondolin is distributed at
[`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt). MIT and ISC license texts
and copyright notices are also distributed by their respective npm packages.

Gondolin downloads its guest kernel and root filesystem separately at runtime;
those assets are not bundled in the `pi-subagent` npm package. Their component
licenses remain part of the corresponding Gondolin asset distribution.
