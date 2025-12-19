import {StageContext} from "./StageContext";

/** Factory that converts the generic core context into whatever scope object the consumer wants */
export type ScopeFactory<TScope> = (core: StageContext, stageName: string, readOnlyContext?: unknown) => TScope;
