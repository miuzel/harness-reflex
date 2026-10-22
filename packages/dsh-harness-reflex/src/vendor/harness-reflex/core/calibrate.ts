import * as fs from 'fs';
import * as path from 'path';

export interface CalibrationBin {
  rawMin: number;
  rawMax: number;
  calibrated: number;
}

export interface CalibrationCurve {
  targetModel: string;
  taskType: string;
  method: 'isotonic' | 'platt';
  createdAt: string;
  bins: CalibrationBin[];
  plattParams?: { a: number; b: number };
  eceBefore: number;
  eceAfter: number;
}

export interface CalibrationSample {
  id?: string;
  rawProbability: number;
  groundTruth: 0 | 1;
}

/**
 * Isotonic Regression using the Pool Adjacent Violators Algorithm (PAVA)
 * Fits a non-decreasing, non-parametric mapping from raw probabilities to calibrated probabilities.
 */
export function fitIsotonicRegression(samples: CalibrationSample[]): CalibrationBin[] {
  if (samples.length === 0) return [];

  // Sort samples ascending by rawProbability
  const sorted = [...samples].sort((a, b) => a.rawProbability - b.rawProbability);

  // Initialize blocks: each block has weight, sum of y, and range of x
  interface Block {
    weight: number;
    sumY: number;
    value: number; // mean y
    xMin: number;
    xMax: number;
  }

  const blocks: Block[] = sorted.map((s) => ({
    weight: 1,
    sumY: s.groundTruth,
    value: s.groundTruth,
    xMin: s.rawProbability,
    xMax: s.rawProbability
  }));

  // PAVA: Merge adjacent blocks that violate monotonicity (value[i] > value[i+1])
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].value > blocks[i + 1].value) {
      // Pool adjacent violators
      const pooledWeight = blocks[i].weight + blocks[i + 1].weight;
      const pooledSumY = blocks[i].sumY + blocks[i + 1].sumY;
      const pooledValue = pooledSumY / pooledWeight;

      blocks[i] = {
        weight: pooledWeight,
        sumY: pooledSumY,
        value: pooledValue,
        xMin: blocks[i].xMin,
        xMax: blocks[i + 1].xMax
      };
      blocks.splice(i + 1, 1);

      // Check backward to restore monotonicity
      if (i > 0) {
        i--;
      }
    } else {
      i++;
    }
  }

  // Convert blocks to continuous CalibrationBins spanning 0.0 to 1.0
  const bins: CalibrationBin[] = [];
  for (let k = 0; k < blocks.length; k++) {
    const prevMax = k === 0 ? 0.0 : bins[k - 1].rawMax;
    const nextMin = k === blocks.length - 1 ? 1.0 : (blocks[k].xMax + blocks[k + 1].xMin) / 2;

    bins.push({
      rawMin: Number(prevMax.toFixed(4)),
      rawMax: Number(nextMin.toFixed(4)),
      calibrated: Number(Math.min(1.0, Math.max(0.0, blocks[k].value)).toFixed(4))
    });
  }

  // Ensure last bin caps at 1.0
  if (bins.length > 0) {
    bins[bins.length - 1].rawMax = 1.0;
  }

  return bins;
}

/**
 * Calculates Expected Calibration Error (ECE)
 */
export function calculateECE(
  samples: Array<{ probability: number; groundTruth: 0 | 1 }>,
  numBins = 10
): number {
  if (samples.length === 0) return 0;

  const binStep = 1.0 / numBins;
  let totalEce = 0;
  const n = samples.length;

  for (let i = 0; i < numBins; i++) {
    const binMin = i * binStep;
    const binMax = (i + 1) * binStep;

    const inBin = samples.filter((s) => s.probability >= binMin && (i === numBins - 1 ? s.probability <= binMax : s.probability < binMax));
    if (inBin.length === 0) continue;

    const binAcc = inBin.reduce((acc, s) => acc + s.groundTruth, 0) / inBin.length;
    const binConf = inBin.reduce((acc, s) => acc + s.probability, 0) / inBin.length;

    totalEce += (inBin.length / n) * Math.abs(binAcc - binConf);
  }

  return Number(totalEce.toFixed(4));
}

/**
 * Online Calibration Engine
 * Loads pre-fitted curves and maps raw probabilities to calibrated true probabilities.
 */
export class Calibrator {
  private static instance: Calibrator;
  private curve: CalibrationCurve | null = null;

  constructor(customCurvePath?: string) {
    const defaultPath = path.join(process.cwd(), '.reflex', 'calibration.json');
    const targetPath = customCurvePath || process.env.SYSTEM_ONE_CALIBRATION_FILE || defaultPath;
    this.loadFromDisk(targetPath);
  }

  static getInstance(): Calibrator {
    if (!Calibrator.instance) {
      Calibrator.instance = new Calibrator();
    }
    return Calibrator.instance;
  }

  loadFromDisk(filePath: string): boolean {
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        this.curve = JSON.parse(data);
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  setCurve(curve: CalibrationCurve): void {
    this.curve = curve;
  }

  isLoaded(): boolean {
    return this.curve !== null;
  }

  getCurve(): CalibrationCurve | null {
    return this.curve;
  }

  /**
   * Calibrate a raw probability
   */
  calibrate(rawProb: number): { calibrated: number; isCalibrated: boolean } {
    if (!this.curve || !this.curve.bins || this.curve.bins.length === 0) {
      return { calibrated: rawProb, isCalibrated: false };
    }

    const clamped = Math.max(0.0, Math.min(1.0, rawProb));

    // Linear interpolation or bin lookup
    for (const bin of this.curve.bins) {
      if (clamped >= bin.rawMin && clamped <= bin.rawMax) {
        return { calibrated: bin.calibrated, isCalibrated: true };
      }
    }

    // Fallback to nearest boundary
    if (clamped < this.curve.bins[0].rawMin) {
      return { calibrated: this.curve.bins[0].calibrated, isCalibrated: true };
    }
    const last = this.curve.bins[this.curve.bins.length - 1];
    return { calibrated: last.calibrated, isCalibrated: true };
  }
}
