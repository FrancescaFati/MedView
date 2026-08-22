# MedView

A NIfTI (.nii, .nii.gz) and DICOM (.dcm) medical image viewer for Visual Studio Code and Cursor.

## Features

**Multi-planar reconstruction** — view axial, sagittal, and frontal planes.

**Image controls** — brightness and contrast, rotation, horizontal/vertical flip, and navigation by keyboard, mouse wheel, or slice slider, all rendered in real time on the GPU.

**Segmentation overlay** — label volumes found beside the image or in its subfolders are detected automatically (e.g. `case/CT.nii.gz` alongside `case/ovseg_predictions/CT.nii.gz`); anything else can be added with Browse. Each label gets its own color and voxel count, with an opacity slider, fill or outline rendering, and click-to-hide. Mismatched grids are rejected rather than silently misaligned.

**Performance** — files stream to the viewer as binary and decode in a background worker, so a 330 MB compressed CT (a 760 MB volume) opens in a few seconds without blocking the interface.

**Fidelity** — native resolution, physical aspect ratio from voxel spacing, and consistent intensity normalization across slices.

## Installation

Search for "MedView" in the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`) of VS Code or Cursor and install.

To install manually, download the `.vsix` file from the releases, then run `Extensions: Install from VSIX...` from the Command Palette.

## Usage

Opening a `.nii`, `.nii.gz`, or `.dcm` file launches MedView automatically. If it doesn't, right-click the file, choose "Open With...", and select "MedView Medical Image Viewer".

| Action | Control |
|---|---|
| Navigate slices | Arrow keys, mouse wheel, or the slice slider |
| Jump 10 slices | Page Up / Page Down |
| First / last slice | Home / End |
| Switch plane (NIfTI) | Plane buttons |
| Rotate / flip | Toolbar controls |
| Brightness / contrast | Sliders in the right panel |

DICOM files are single-slice, so multi-planar controls are hidden and only brightness, contrast, and transformation tools apply.

## Troubleshooting

**Files don't open with MedView automatically.** Right-click the file → "Open With..." → "MedView Medical Image Viewer" → check "Configure default editor".

**Images look distorted.** MedView applies aspect ratio from voxel spacing automatically; if this looks wrong, check the file's header.

**Large files load slowly.** Header information loads first, followed by image data in the background — this is expected for very large volumes.

## Contributing

Bug reports, feature requests, and pull requests are welcome.

## License

GPLv3. See [LICENSE](LICENSE) for details.
