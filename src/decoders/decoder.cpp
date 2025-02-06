#include <cstdint>
#include <vector>

extern "C" {
    struct ImageData {
        int width;
        int height;
        uint8_t* data;
    };

    ImageData decode_bmp(const uint8_t* buffer, int size) {
        // Simple BMP decoding logic (this is a basic example and doesn't handle all BMP formats)
        int width = *reinterpret_cast<const int*>(buffer + 18);
        int height = *reinterpret_cast<const int*>(buffer + 22);
        int dataOffset = *reinterpret_cast<const int*>(buffer + 10);

        std::vector<uint8_t> pixelData(width * height * 3);
        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                int srcIdx = dataOffset + (height - 1 - y) * ((width * 3 + 3) & ~3) + x * 3;
                int destIdx = (y * width + x) * 3;
                pixelData[destIdx] = buffer[srcIdx + 2];     // R
                pixelData[destIdx + 1] = buffer[srcIdx + 1]; // G
                pixelData[destIdx + 2] = buffer[srcIdx];     // B
            }
        }

        return {width, height, pixelData.data()};
    }
}
