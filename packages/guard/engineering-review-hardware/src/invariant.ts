/** Package-owned invariant companion for the stateless hardware review adapter. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-engineering-review-hardware'

/** Cordis companion plugin name. */
export const name = 'engineering-review-hardware-invariant'
/** Service required before package ownership can be registered. */
export const inject = ['invariants']

/** No runtime invariant: the adapter owns no event history or mutable projection. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
