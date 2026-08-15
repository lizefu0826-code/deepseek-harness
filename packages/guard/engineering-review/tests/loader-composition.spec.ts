import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/guard/engineering-review/',
  import.meta.url,
))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'cordis.yml')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('engineering-review public Loader composition', () => {
  it('loads the service, tool, skill, configuration, and hardware adapter without a model key', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'engineering-review Loader composition',
      tempDirPrefix: 'dsh-engineering-review-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toMatchInlineSnapshot(`
      {
        "report": {
          "checks": 0,
          "degradedReasons": [],
          "passed": true,
          "reviewerUsed": false,
          "risk": "medium",
        },
        "skill": {
          "name": "engineering-review",
          "source": "bundled",
        },
        "tool": {
          "name": "engineering_review",
          "parameterNames": [
            "depth",
            "focus",
          ],
        },
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
