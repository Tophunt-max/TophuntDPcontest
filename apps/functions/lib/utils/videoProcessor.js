"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processVideoToHLS = void 0;
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const processVideoToHLS = async (inputPath, outputFolder) => {
    if (!fs_1.default.existsSync(outputFolder)) {
        fs_1.default.mkdirSync(outputFolder, { recursive: true });
    }
    const playlistName = 'playlist.m3u8';
    const thumbnailName = 'thumb.jpg';
    const playlistPath = path_1.default.join(outputFolder, playlistName);
    const thumbnailPath = path_1.default.join(outputFolder, thumbnailName);
    return new Promise((resolve, reject) => {
        // 1. Generate Thumbnail
        (0, fluent_ffmpeg_1.default)(inputPath)
            .screenshots({
            timestamps: [0.5],
            filename: thumbnailName,
            folder: outputFolder,
            size: '720x1280'
        })
            .on('end', () => {
            // 2. Generate HLS Segments
            (0, fluent_ffmpeg_1.default)(inputPath)
                .outputOptions([
                '-profile:v baseline',
                '-level 3.0',
                '-start_number 0',
                '-hls_time 4',
                '-hls_list_size 0',
                '-f hls'
            ])
                .output(playlistPath)
                .on('end', () => {
                const files = fs_1.default.readdirSync(outputFolder);
                resolve({
                    playlistPath,
                    thumbnailPath,
                    files: files.map(f => path_1.default.join(outputFolder, f))
                });
            })
                .on('error', (err) => reject(err))
                .run();
        })
            .on('error', (err) => reject(err));
    });
};
exports.processVideoToHLS = processVideoToHLS;
//# sourceMappingURL=videoProcessor.js.map