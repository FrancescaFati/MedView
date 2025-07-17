# Change Log

All notable changes to the "MedView" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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