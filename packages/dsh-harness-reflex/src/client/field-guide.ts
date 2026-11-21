/**
 * In-place guidance for every editable settings field.
 *
 * One row per Host schema path. The page uses the row for the label copy key,
 * the empty-input example, and the `(?)` explanation key, so a field cannot
 * gain a placeholder without a matching help entry. Dynamic rows (tool
 * switches and intervention capabilities) are keyed by `<path>.*` and filled by
 * the page from the row template.
 *
 * Everything here is browser copy only: the table never restates a default or a
 * constraint. Those live in the locale help text and are cross-checked against
 * the Host's own `resolveConfig` by `field-guidance.test.ts`, so the copy cannot
 * silently drift from the schema.
 *
 * @module dsh-reflex/client/field-guide
 */

/** Guidance for one editable field. */
export interface FieldGuide {
  /** Locale key of the visible label; omitted for dynamic rows that supply one. */
  labelKey?: string;
  /** Locale key of the `(?)` explanation. */
  helpKey: string;
  /** Example shown while the input is empty; omitted for selects and switches. */
  placeholder?: string;
}

/** Path → guidance. Paths use the Host schema (`systemOne.baseUrl`), not draft names. */
export const FIELD_GUIDE: Record<string, FieldGuide> = {
  'routing.enabled': { labelKey: 'labelEnabled', helpKey: 'helpRoutingEnabled' },
  'routing.virtualProvider': { labelKey: 'labelVirtualProvider', helpKey: 'helpVirtualProvider', placeholder: 'reflex' },
  'routing.fallback': { labelKey: 'labelFallback', helpKey: 'helpFallback', placeholder: 'provider:model' },
  'routing.maxTaskChars': { labelKey: 'labelMaxTaskChars', helpKey: 'helpMaxTaskChars', placeholder: '400' },

  'effort.enabled': { labelKey: 'labelEffortEnabled', helpKey: 'helpEffortEnabled' },
  'effort.setting': { labelKey: 'labelEffortSetting', helpKey: 'helpEffortSetting' },
  'effort.fallback': { labelKey: 'labelEffortFallback', helpKey: 'helpEffortFallback' },
  'effort.minConfidence': { labelKey: 'labelEffortMinConfidence', helpKey: 'helpEffortMinConfidence', placeholder: '0.3' },

  backend: { labelKey: 'labelBackend', helpKey: 'helpBackend' },
  // The connection fields live on a profile now (g-066); the flat entries here
  // were the compatibility block's, and the block is gone. The profile's own
  // fields carry their labels from the row, and the model list — the one field
  // whose shape is new — gets the guidance because it is the one a user will
  // wonder about.
  'systemOne.profiles.modelIds': { labelKey: 'labelModelIds', helpKey: 'helpModelIds', placeholder: 'jev-latest' },
  'systemOne.profiles.selectedModel': { labelKey: 'labelModel', helpKey: 'helpSelectedModel' },

  toolPrefix: { labelKey: 'labelToolPrefix', helpKey: 'helpToolPrefix', placeholder: 'reflex_' },
  pruneThreshold: { labelKey: 'labelPruneThreshold', helpKey: 'helpPruneThreshold', placeholder: '500' },
  ledgerPath: { labelKey: 'labelLedgerPath', helpKey: 'helpLedgerPath', placeholder: '.reflex/ledger.jsonl' },
  calibrationPath: { labelKey: 'labelCalibrationPath', helpKey: 'helpCalibrationPath', placeholder: 'path/to/calibration.json' },

  'interventions.mode': { labelKey: 'labelInterventionMode', helpKey: 'helpInterventionMode' },
  'interventions.maxInterventionsPerTurn': {
    labelKey: 'labelMaxInterventionsPerTurn',
    helpKey: 'helpMaxInterventionsPerTurn',
    placeholder: '3'
  },
  'interventions.maxJudgmentsPerTurn': { labelKey: 'labelMaxJudgmentsPerTurn', helpKey: 'helpMaxJudgmentsPerTurn', placeholder: '3' },
  'interventions.maxJudgmentsPerSession': {
    labelKey: 'labelMaxJudgmentsPerSession',
    helpKey: 'helpMaxJudgmentsPerSession',
    placeholder: '20'
  },
  'interventions.repeatThreshold': { labelKey: 'labelRepeatThreshold', helpKey: 'helpRepeatThreshold', placeholder: '3' },
  'interventions.failureThreshold': { labelKey: 'labelFailureThreshold', helpKey: 'helpFailureThreshold', placeholder: '3' },
  'interventions.minConfidence': {
    labelKey: 'labelInterventionMinConfidence',
    helpKey: 'helpInterventionMinConfidence',
    placeholder: '0.6'
  },
  'interventions.windowSize': { labelKey: 'labelWindowSize', helpKey: 'helpWindowSize', placeholder: '6' },
  'interventions.pruneFloorRatio': { labelKey: 'labelPruneFloorRatio', helpKey: 'helpPruneFloorRatio', placeholder: '0.5' },
  'interventions.pruneHeadChars': { labelKey: 'labelPruneHeadChars', helpKey: 'helpPruneHeadChars', placeholder: '400' },
  'interventions.pruneTailChars': { labelKey: 'labelPruneTailChars', helpKey: 'helpPruneTailChars', placeholder: '400' },
  'interventions.intent': {
    labelKey: 'labelPruneIntent',
    helpKey: 'helpPruneIntent',
    placeholder: 'extract diagnostics, relevant results and errors'
  },
  'interventions.pruneJudgeMinChars': {
    labelKey: 'labelPruneJudgeMinChars',
    helpKey: 'helpPruneJudgeMinChars',
    placeholder: '10000'
  },
  'interventions.claimMinConfidence': {
    labelKey: 'labelClaimMinConfidence',
    helpKey: 'helpClaimMinConfidence',
    placeholder: '0.5'
  },
  'interventions.closingEvidenceChars': {
    labelKey: 'labelClosingEvidenceChars',
    helpKey: 'helpClosingEvidenceChars',
    placeholder: '2400'
  },

  // Dynamic rows: the page substitutes the suffix / capability into the label
  // and fills the `{...}` holes in the explanation.
  'tools.enabled.*': { helpKey: 'helpToolSwitch' },
  'interventions.capabilities.*': { helpKey: 'helpCapability' }
};

/**
 * Look up a field's guidance by its schema path.
 * @param path - schema path such as `routing.virtualProvider`.
 * @returns the row, or `undefined` when the path is not part of this table.
 */
export function guideFor(path: string): FieldGuide | undefined {
  return FIELD_GUIDE[path];
}

/**
 * Look up a dynamic field's guidance by family prefix.
 * @param family - `tools.enabled` or `interventions.capabilities`.
 * @returns the wildcard row, or `undefined`.
 */
export function templateGuideFor(family: string): FieldGuide | undefined {
  return FIELD_GUIDE[`${family}.*`];
}
