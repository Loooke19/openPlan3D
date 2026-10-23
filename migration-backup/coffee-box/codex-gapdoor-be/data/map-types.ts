/** Coordinates are normalized to the ORIGINAL full PDF page, including legend. */
export type Point = [number, number];
export type Calibration = null | {
  metersPerMapUnit: number;
  referencePoints: [Point, Point];
  referenceMeters: number;
  source: 'user-entered';
};
export interface RouteNode { id: string; position: Point; kind: 'junction' | 'poi'; poiId?: string }
export interface RouteEdge {
  id: string; source: string; target: string; lengthMapUnits: number;
  polyline: Point[]; enabled: boolean; mode: 'walk'; accessibility: 'unknown';
}
export interface POI {
  id: string; name: string; category: string; sourceLabel: string;
  labelPosition: Point; requestedAnchor: Point; position: Point | null;
  anchorStatus: 'demo' | 'visible' | 'inferred'; confidence: number;
  confidenceMeaning: string; notes: string; nodeId: string | null;
  roomId: string | null; floorId: string; componentId: number | null;
  snapMapUnits: number;
}
export interface DemoDoor {
  id: string; poiId: string; obstacleId: string; position: Point;
  corridorAnchor: Point; provenance: 'demo-placement'; opensRoomInterior: false;
}
export interface MapDocument {
  schemaVersion: '1.0.0'; id: string; name: string; status: 'demo'; floorId: string;
  source: {url: string; pdfUrl: string; pdfSha256: string; page: number;
    pdfSize: Point; imageSize: Point; imageUrl: string};
  calibration: Calibration;
  geometry: {buildingBoundary: Point[]; obstacles: Array<{id: string; kind: string;
    polygon: Point[]; color: number[]; sourceObject: string; name?: string}>;
    wallSegments: Point[][]; walkableMaskUrl: string; safeMaskUrl: string;
    clearance: {value: number; unit: 'pdf-map-unit'; physicalRadiusVerified: false}};
  pois: POI[]; doors: DemoDoor[];
  graph: {algorithm: string; coordinateSystem: 'normalized-top-left'; nodes: RouteNode[]; edges: RouteEdge[]};
  notes: string[];
}

/** Production draft used before a MapDocument snapshot is published. Not loaded by the demo viewer yet. */
export type PageRotation = 0 | 90 | 180 | 270;
export interface PageCrop { x: number; y: number; width: number; height: number }
export interface MapDraftPage {
  index: number;
  originalSize: Point;
  rotation: PageRotation;
  /** Crop in original page units; null means the full page. Does not change the 0..1 basis. */
  crop: PageCrop | null;
  pixelSize: Point;
}
export interface MapDraft {
  schemaVersion: 'draft-1.0.0';
  id: string;
  revision: number;
  sourceFile: { sha256: string; fileName: string; byteLength: number };
  page: MapDraftPage;
  candidates: {
    rooms: Array<Record<string, unknown>>;
    corridors: Array<Record<string, unknown>>;
    labels: Array<Record<string, unknown>>;
    doors: Array<Record<string, unknown>>;
  };
  edits: {
    renamedPois: Record<string, string>;
    renamedRooms?: Record<string, string>;
    facilityIcons?: Array<{ id: string; category: string; name?: string; position: Point }>;
    polygonOverrides: Record<string, Point[]>;
    maskStrokes: Array<Record<string, unknown>>;
    confirmedIds: string[];
  };
  pending: Array<{ id: string; kind: string; message: string }>;
  /** Last compatible viewer snapshot, if already built. */
  mapDocument: MapDocument | null;
}

