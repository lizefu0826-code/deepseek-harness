#!/usr/bin/env node
/** Inspect and execute the public engineering-review composition without a key. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-engineering-review'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('engineering-review driver requires a config path')

const ctx = await boot('engineering-review-loader-composition', resolveConfigPath(configPath, undefined))
try {
  const agent = ctx.agents.get(SessionId('main'))
  if (agent === undefined) throw new Error('main agent was not registered')
  const tool = ctx.tools.schemas(agent).find(schema => schema.name === 'engineering_review')
  if (tool === undefined) throw new Error('engineering_review tool was not registered')
  const skill = await ctx.skills.get('engineering-review', {
    cwd: process.cwd(),
    scope: agent,
    signal: new AbortController().signal,
  })
  const signal = new AbortController().signal
  const report = await ctx.engineeringReview.review({
    agent,
    signal,
    cwd: process.cwd(),
    fingerprint: 'keyless-c-fixture',
    changedPaths: ['firmware/driver.c'],
    diff: '+ if (ready) return 0;',
    diffTruncated: false,
    depth: 'fast',
    readText: () => Promise.resolve(undefined),
    hasFile: () => Promise.resolve(false),
  })
  const properties = tool.parameters.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error('engineering_review tool has invalid parameters')
  }
  process.stdout.write(`${JSON.stringify({
    tool: {
      name: tool.name,
      parameterNames: Object.keys(properties).sort(),
      required: tool.parameters.required,
    },
    skill: { name: skill?.name, source: skill?.source },
    report: {
      risk: report.risk,
      passed: report.passed,
      checks: report.checks.length,
      reviewerUsed: report.reviewer.used,
      degradedReasons: report.degradedReasons,
    },
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
