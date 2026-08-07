export {Vox} from './vox/grid'
export type {GridSize} from './vox/grid'
export {PALETTE, EMPTY, colorOf} from './vox/palette'
export type {Rgba} from './vox/palette'

export {DEFAULT_PALETTE, hasVoxel, layersByZ, packKey, unpackKey} from './vox/model'
export type {VoxModel} from './vox/model'
export {readVox} from './vox/vox-file'

export {composeSheet, composeStacked, sliceLayers} from './vox/slice'
export {light, prepareNormals, renderAngle, rotationSheet} from './vox/render'
export type {LightOptions, NormalField, RenderedAngle, RenderOptions} from './vox/render'

export {CHUNK_SIZE, MAX_COORD, Volume, uniqueChunkBytes} from './doc/volume'
export type {Bounds} from './doc/volume'
export {
    addFrame,
    addLayer,
    addTag,
    celAt,
    createDocument,
    createLayer,
    documentBytes,
    documentVolumes,
    duplicateFrame,
    editCel,
    flattenFrame,
    frameToModel,
    layerAt,
    moveLayer,
    removeFrame,
    removeLayer,
    removeTag,
    setPalette,
    tagsAt,
    uniqueTagName,
    updateLayer,
    updateTag
} from './doc/document'
export type {Document, DocumentInit, Layer, LayerOffset, Ramp, Tag} from './doc/document'
export {addRamp, documentFromModel, frameToVox, removeRamp} from './doc/document'
export {
    applyPaletteOrder,
    closeColors,
    colorDistance,
    colorUsage,
    flatSlicePairs,
    fromHsv,
    gradient,
    gradientByHue,
    lightness,
    mergeDuplicates,
    rampFromGradient,
    replaceColorEverywhere,
    shadeStep,
    sortOrder,
    sortPalette,
    toHsv
} from './doc/palette'
export type {FlatSlicePair, PaletteCollision, SortKey} from './doc/palette'
export {
    decodePalette,
    encodePalette,
    fromGpl,
    fromHex,
    fromPal,
    fromStrip,
    toGpl,
    toHex,
    toPal,
    toStrip
} from './doc/palette-formats'
export type {PaletteFormat} from './doc/palette-formats'
export {
    PROJECT_VERSION,
    colorFromHex,
    colorToHex,
    decodeVolume,
    deserializeDocument,
    encodeVolume,
    loadProject,
    saveProject,
    serializeDocument
} from './doc/serialize'
export type {SerializedDocument, SerializedLayer} from './doc/serialize'
export {
    copySlice,
    ellipse,
    floodFill,
    line,
    mirrorVolume,
    plot,
    rect,
    replaceColor
} from './doc/tools'
export type {ToolContext} from './doc/tools'
export {History} from './doc/history'
export type {HistoryEntry, HistoryOptions} from './doc/history'

export {
    applyStroke,
    beginStroke,
    copyToClipboard,
    deleteSelected,
    deselect,
    extendStroke,
    isSelectionTool,
    labelFor,
    pasteAt,
    selectAll
} from './editor/state'
export type {EditorSnapshot, Stroke, StrokeResult, Tool} from './editor/state'
export {flipY, renderSlice, selectionOutline, toVoxel} from './editor/canvas'
export {baseName, isVoxBytes, readImport, readPalette} from './editor/files'
export type {ImportedFile} from './editor/files'
export {
    VIEWS,
    pickAttach,
    pickSurface,
    rayFor,
    renderOrtho,
    toCell,
    viewSize
} from './editor/view3d'
export type {Axis, OrthoOptions, OrthoView, PickOptions, ViewMapping, Voxel} from './editor/view3d'
export {
    applyAxisLock,
    applyBrush3d,
    applyVoxels,
    brushTarget,
    brushVoxels,
    faceRegion,
    line3d
} from './editor/brush3d'
export type {Brush3D, BrushMode, BrushShape, Gesture3D} from './editor/brush3d'
export {
    boxFromDrag,
    boxOf,
    boxVoxels,
    pickColor,
    removeColor,
    selectBox,
    selectRegion,
    voxelsOfColor
} from './editor/select3d'
export type {Box3} from './editor/select3d'

export {VOX_SCHEMA, rasterise} from './gen/ops'
export type {BallOp, BoxOp, EraseOp, Vec3, VoxOp, VoxSpec} from './gen/ops'
export {DEFAULT_ENDPOINT, SYSTEM, generateMany, generateOne} from './gen/llama'
export type {
    Candidate,
    GenerateManyResult,
    GenerateOptions,
    GenerationRecord,
    Sampler
} from './gen/llama'
export {
    bboxFill,
    connectivity,
    overallScore,
    paletteCompliance,
    scoreModel,
    sliceUsage,
    symmetryX
} from './gen/score'
export type {ModelScores} from './gen/score'
export type {SliceViewOptions} from './editor/canvas'

export {
    clearSelection,
    copySelection,
    emptySelection,
    intersectSelection,
    invertSelection,
    isEmptySelection,
    isSelected,
    lassoSelection,
    moveSelection,
    offsetSelection,
    pasteClipboard,
    rectSelection,
    selectionBounds,
    selectionCount,
    subtractSelection,
    unionSelection,
    wandSelection
} from './doc/selection'
export type {Clipboard, Selection} from './doc/selection'

export {blit, createImage} from './image/rgba'
export type {RgbaImage} from './image/rgba'
export {decodePng, encodePng} from './image/png'

export {opaqueBounds, packAtlas, sidecarJson} from './export/atlas'
export type {Atlas, AtlasFrame, AtlasOptions, AtlasSidecar} from './export/atlas'
export {godotCanvasTexture, godotResource} from './export/godot'
export type {GodotOptions} from './export/godot'
export {
    applyStrip,
    cellOrigin,
    documentFromStrip,
    sliceStrip,
    stripLayout,
    stripSize
} from './export/strip'
export type {StripLayout} from './export/strip'
export type {DocumentOrigin} from './doc/document'

export {bakeRig, mirrorBone, poseAt, poseVolume} from './anim/rig'
export type {Bone, BoneKey, Rig} from './anim/rig'

export {
    applyPasses,
    dither,
    emptyLike,
    lambert,
    normalOcclusion,
    outline,
    paletteCycle
} from './fx/passes'
export type {Pass} from './fx/passes'
export {FUNCTIONS, compile, evaluate, tokenize} from './fx/expr'
export type {Scope} from './fx/expr'
export {SCRIPT_PRESETS, runVoxelScript} from './fx/voxelScript'
export type {ScriptOptions, ScriptResult} from './fx/voxelScript'

export {evolve, makeRng, mutateSpec} from './gen/evolve'
export type {EvolveOptions, EvolveResult, MutateOptions, Rng} from './gen/evolve'
export {DEFAULT_SCORER, probeScorer, rankAgreement, scoreWithClip} from './gen/clip'
export type {ScorerOptions} from './gen/clip'

export {IDENTITY_ROTATION, readVoxScene, writeVoxScene} from './vox/vox-scene'
export type {SceneLayer, SceneModel, VoxScene} from './vox/vox-scene'
export {documentFromScene, frameToLayeredVox, frameToVoxScene} from './doc/document'

export {atlasMeta, atlasModels, packModels} from './export/atlas'
export type {AtlasMeta} from './export/atlas'
export {runBake} from './vox/render-worker'
export type {BakeFailure, BakeRequest, BakeResponse} from './vox/render-worker'

export {angleAdvice, axisAlignedCoverage} from './export/angles'
export type {AngleAdvice, AngleAdviceOptions, AngleOption} from './export/angles'
