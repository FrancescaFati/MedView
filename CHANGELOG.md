# Change Log

All notable changes to the "MedView" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.1.0] - 2026-08-06

### Added
- **Segmentation overlay.** Label volumes can be overlaid on the image with a
  per-label colour, an opacity slider, fill or outline rendering, and
  click-to-hide toggles listing each label's voxel count.
- **Automatic segmentation discovery.** On opening an image, MedView looks for
  matching label volumes beside it and in subfolders (for example
  `case/CT.nii.gz` together with `case/ovseg_predictions/CT.nii.gz`) and offers
  them in a dropdown. `Browse…` picks any other file.
- Real progress reporting while a file downloads, decompresses and is analysed.
- The header bar now shows the volume dimensions, voxel spacing and data type.

### Fixed
- **Large images no longer take minutes to open, or fail to open at all.** File
  bytes were previously handed to the viewer via `Array.from()` and serialised
  as JSON, which expanded an N byte file into an N element JavaScript array
  before turning it into text. Beyond roughly 150 MB this was extremely slow,
  and past a few hundred megabytes the resulting string exceeded what the
  runtime could hold, so the image never appeared. The viewer now streams the
  file directly as binary.
- Slice rendering no longer copies the slice into a `Float32Array`, re-reads the
  canvas framebuffer, or redraws through a scratch canvas on every change.

### Changed
- Decompression, header parsing and intensity analysis now run in a Web Worker
  using the browser's native gzip, so the interface stays responsive while a
  large volume loads.
- Float32 label maps are repacked to 8- or 16-bit on load, which typically cuts
  their memory use by 4x.
- Rotation and flipping are applied as a CSS transform rather than by rewriting
  pixels.
- The viewer's HTML, CSS and JavaScript moved out of `src/extension.ts` into
  `media/`.

## [1.0.0] - 2024-12-19

### Added
- Initial release of MedView medical image viewer
- Support for NIfTI (.nii, .nii.gz) and DICOM (.dcm) file formats
- Multi-planar reconstruction with axial, sagittal, and coronal views
- Advanced image controls including brightness, contrast, and window/level adjustment
- Image transformations (rotate, flip)
- Interactive navigation with keyboard shortcuts and mouse controls
- DICOM series viewer for folder-based DICOM collections
- GPU-accelerated rendering for smooth performance
- Memory-efficient loading for large datasets
- Physical aspect ratio preservation based on voxel spacing
- Global intensity normalization across slices
- Professional medical imaging interface optimized for clinical workflows

### Technical Features
- Custom DICOM parser with comprehensive metadata extraction
- NIfTI reader integration with support for all standard data types
- WebView-based interface with VS Code theme integration
- Automatic file format detection and appropriate viewer selection
- Progressive loading for large medical image files
- Error handling and graceful degradation for corrupted files

### Documentation
- Comprehensive README with installation and usage instructions
- Troubleshooting guide for common issues
- Technical specifications and compatibility information