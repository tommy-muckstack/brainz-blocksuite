import { ConnectionOverlay } from '@blocksuite/affine-block-surface';
import { EditPropsStore } from '@blocksuite/affine-shared/services';
import { StdIdentifier } from '@blocksuite/block-std';
import { createIdentifierFromConstructor, type Container } from '@blocksuite/global/di';
import { Bound, getPointFromBoundsWithRotation, type IVec } from '@blocksuite/global/utils';

export class CanvasEditPropsStore extends EditPropsStore {
  static override setup(container: Container) {
    EditPropsStore.setup(container);
    container.override(createIdentifierFromConstructor(EditPropsStore), this, [StdIdentifier]);
  }

  override recordLastProps(...[key, props]: Parameters<EditPropsStore['recordLastProps']>) {
    // The 0.19.5 palette offers transparency, but its style-cache schema omits
    // that palette token. Use its supported custom-color form in the cache;
    // keep the original document properties and all other validation intact.
    const normalized = Object.fromEntries(Object.entries(props).map(([property, value]) => [
      property,
      ['fillColor', 'strokeColor', 'stroke', 'color', 'background'].includes(property) && value === '--affine-palette-transparent'
        ? {normal: 'transparent'} : value,
    ]));
    super.recordLastProps(key, normalized);
  }
}

export class CanvasConnectionOverlay extends ConnectionOverlay {
  override render(context: CanvasRenderingContext2D) {
    if (this.gfx.tool.currentToolName$.peek() !== 'connector') {
      super.render(context);
      return;
    }

    const zoom = this.gfx.viewport.zoom;
    context.save();
    context.fillStyle = '#24241f';
    context.strokeStyle = '#e2c76b';
    context.lineWidth = 1.5 / zoom;

    for (const element of this.gfx.getElementsByBound(this.gfx.viewport.viewportBounds)) {
      if (!element.connectable || ('hidden' in element && element.hidden) || ('display' in element && element.display === false)) continue;
      const bounds = Bound.deserialize(element.xywh);
      // Match BlockSuite's connection hit-testing: intersect each center ray
      // with the actual outline, including rotated and non-rectangular shapes.
      const rays: IVec[] = [
        [bounds.center[0], bounds.y - 10],
        [bounds.center[0], bounds.maxY + 10],
        [bounds.x - 10, bounds.center[1]],
        [bounds.maxX + 10, bounds.center[1]],
      ];
      for (const ray of rays) {
        const end = getPointFromBoundsWithRotation({...bounds, rotate: element.rotate}, ray);
        const point = element.getLineIntersections(bounds.center as IVec, end)?.[0];
        if (!point) continue;
        context.beginPath();
        context.arc(point[0], point[1], 4.5 / zoom, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
    }

    if (this.highlightPoint) {
      context.beginPath();
      context.arc(this.highlightPoint[0], this.highlightPoint[1], 5.5 / zoom, 0, Math.PI * 2);
      context.fillStyle = '#e2c76b';
      context.fill();
      context.stroke();
    }
    context.restore();
  }
}
