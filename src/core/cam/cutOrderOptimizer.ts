import { ToolpathOperation, Point2D, RapidTravel } from '../../types/cam';

export class CutOrderOptimizer {
  /**
   * Sorts toolpath operations to maintain mechanical integrity and optimize rapid travel:
   * 1. All internal holes/cutouts first (nearest-neighbor TSP).
   * 2. Outer boundaries last.
   * Calculates rapid travels (G0) between operations.
   */
  public optimize(operations: ToolpathOperation[]): {
    orderedOperations: ToolpathOperation[];
    rapidTravels: RapidTravel[];
  } {
    if (operations.length <= 1) {
      return {
        orderedOperations: operations,
        rapidTravels: [],
      };
    }

    const internalOps = operations.filter((op) => op.classification === 'INNER_HOLE');
    const outerOps = operations.filter((op) => op.classification !== 'INNER_HOLE');

    // Sort internal cutouts with Nearest Neighbor heuristic starting from (0,0) or first pierce
    const sortedInternals = this.nearestNeighborSort(internalOps, { x: 0, y: 0 });

    // Sort outer perimeters with Nearest Neighbor starting from last internal cut end point
    const startForOuter = sortedInternals.length > 0
      ? sortedInternals[sortedInternals.length - 1].endPoint
      : { x: 0, y: 0 };
    const sortedOuters = this.nearestNeighborSort(outerOps, startForOuter);

    const orderedOperations = [...sortedInternals, ...sortedOuters];

    // Compute rapid travels between operations
    const rapidTravels: RapidTravel[] = [];
    for (let i = 0; i < orderedOperations.length; i++) {
      const from = i === 0 ? { x: 0, y: 0 } : orderedOperations[i - 1].endPoint;
      const to = orderedOperations[i].piercePoint;
      rapidTravels.push({ from, to });
    }

    return {
      orderedOperations,
      rapidTravels,
    };
  }

  private nearestNeighborSort(ops: ToolpathOperation[], startPos: Point2D): ToolpathOperation[] {
    const unvisited = [...ops];
    const sorted: ToolpathOperation[] = [];
    let currentPos = { ...startPos };

    while (unvisited.length > 0) {
      let nearestIdx = 0;
      let minDistance = Infinity;

      for (let i = 0; i < unvisited.length; i++) {
        const dist = Math.hypot(
          unvisited[i].piercePoint.x - currentPos.x,
          unvisited[i].piercePoint.y - currentPos.y
        );
        if (dist < minDistance) {
          minDistance = dist;
          nearestIdx = i;
        }
      }

      const nextOp = unvisited.splice(nearestIdx, 1)[0];
      sorted.push(nextOp);
      currentPos = nextOp.endPoint;
    }

    return sorted;
  }
}
