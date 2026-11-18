import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import type { AnalysisProvider } from "../../ports/AnalysisProvider.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { BinarySession } from "./BinarySession.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";
import type { BundleResourceClientFactory } from "./BundleResourceSession.js";
import type { RetainedTargetLimit } from "../../domain/retainedTargets.js";
import type { RetainedTargetPolicy } from "./BinarySession.js";

/**
 * Compose one provider-neutral session from deep-provider selection and
 * disjoint auxiliary operation families.
 */
export const composeBinarySession = (
  registry: AnalysisProviderRegistry,
  auxiliaryProviders: readonly AnalysisProvider[] = [],
  bundleResourceFactory?: BundleResourceClientFactory,
  retainedTargetLimit: RetainedTargetLimit = 2,
  retainedTargetPolicy?: RetainedTargetPolicy,
): BinarySession =>
  new BinarySession(
    SessionProviderRouter.selectable(registry, auxiliaryProviders),
    new InvestigationRecords(),
    bundleResourceFactory,
    retainedTargetLimit,
    retainedTargetPolicy,
  );
