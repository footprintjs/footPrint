/**
 * Core memory types for pipeline execution
 * 
 * WHY: These types define the contracts for scope creation and context access.
 */

import { StageContext } from './StageContext';

/** Factory that converts the generic core context into whatever scope object the consumer wants */
export type ScopeFactory<TScope> = (core: StageContext, stageName: string, readOnlyContext?: unknown) => TScope;
