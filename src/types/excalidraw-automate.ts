import type { TFile } from 'obsidian';

/**
 * The subset of ExcalidrawAutomate that Mappy calls. The published npm types
 * stopped at 1.9.14 (2023), so these mirror docs/API/ExcalidrawAutomate.d.ts of
 * zsviczian/obsidian-excalidraw-plugin for the members used here only.
 */
export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor?: string;
  link?: string | null;
  customData?: Record<string, unknown> | null;
  groupIds?: string[];
  containerId?: string | null;
  boundElements?: { type: string; id: string }[] | null;
}

export interface ExcalidrawStyle {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  roundness: null | { type: number; value?: number };
  fontFamily: number;
  fontSize: number;
  textAlign: string;
  verticalAlign: string;
}

export interface ExcalidrawViewLike {
  file: TFile | null;
}

export interface ExcalidrawDropData {
  ea: ExcalidrawAutomate;
  event: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean };
  draggable: unknown;
  type: 'file' | 'text' | 'unknown';
  payload: { files: TFile[] | null; text: string | null };
  excalidrawFile: TFile;
  view: ExcalidrawViewLike;
  pointerPosition: { x: number; y: number };
}

export type ExcalidrawDropHook = (data: ExcalidrawDropData) => boolean;

export interface ExcalidrawTextFormatting {
  box?: boolean | 'box' | 'blob' | 'ellipse' | 'diamond';
  boxPadding?: number;
  boxStrokeColor?: string;
  textAlign?: 'left' | 'center' | 'right';
  textVerticalAlign?: 'top' | 'middle' | 'bottom';
  wrapAt?: number;
  width?: number;
  height?: number;
}

export interface ExcalidrawAutomate {
  onDropHook?: ExcalidrawDropHook | null | undefined;
  style: ExcalidrawStyle;
  targetView?: ExcalidrawViewLike | null;
  getAPI(view?: ExcalidrawViewLike): ExcalidrawAutomate;
  setView(view?: ExcalidrawViewLike | 'active' | 'first' | 'auto' | null): ExcalidrawViewLike | null;
  getExcalidrawAPI(): { getAppState(): Record<string, unknown> } | null;
  getViewElements(): ExcalidrawElement[];
  copyViewElementsToEAforEditing(elements: ExcalidrawElement[], copyImages?: boolean): void;
  reset(): void;
  clear(): void;
  destroy?(): void;
  addText(topX: number, topY: number, text: string, formatting?: ExcalidrawTextFormatting, id?: string): string;
  addLine(points: [number, number][], id?: string): string;
  addImage(topX: number, topY: number, imageFile: TFile | string, scale?: boolean, anchor?: boolean): Promise<string | null>;
  addToGroup(objectIds: string[]): string;
  getElement(id: string): ExcalidrawElement | null;
  getElements(): ExcalidrawElement[];
  addElementsToView(
    repositionToCursor?: boolean, save?: boolean, newElementsOnTop?: boolean, shouldRestoreElements?: boolean,
  ): Promise<boolean>;
  selectElementsInView?(elements: string[] | ExcalidrawElement[]): void;
}

declare global {
  interface Window {
    ExcalidrawAutomate?: ExcalidrawAutomate;
  }
}
