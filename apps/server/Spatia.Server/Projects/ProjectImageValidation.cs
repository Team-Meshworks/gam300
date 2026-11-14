using System.Buffers.Binary;

namespace Spatia.Server.Projects;

/// <summary>Checks bounded raster headers and container integrity before private image storage</summary>
internal static class ProjectImageValidation
{
    internal const int MaximumBytes = 2 * 1024 * 1024;

    internal static ProjectImage? Read(ProjectImageUpload upload)
    {
        if (upload.Type is not ("cover" or "panorama") || upload.Data is not { Length: > 0 and <= MaximumBytes }) { return null; }
        var bytes = upload.Data.AsSpan();
        var dimensions = upload.ContentType switch
        {
            "image/png" => Png(bytes),
            "image/jpeg" => Jpeg(bytes),
            "image/webp" => Webp(bytes),
            _ => (0, 0),
        };
        var (width, height) = dimensions;
        // Bound decoded memory as well as compressed input; panoramas keep their exact equirectangular ratio
        if (width <= 0 || height <= 0 || height > 4096 || width > (upload.Type == "panorama" ? 8192 : 4096)
            || (long)width * height > 16_777_216 || (upload.Type == "panorama" && width != 2 * height)) { return null; }
        return new ProjectImage { Id = Guid.NewGuid(), Type = upload.Type, ContentType = upload.ContentType, Data = upload.Data };
    }

    private static (int, int) Png(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 45 || !bytes[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) { return (0, 0); }
        var offset = 8;
        var width = 0;
        var height = 0;
        var pixels = false;
        // Check complete chunks and their checksums, including the final IEND rather than trusting a PNG prefix
        while (offset <= bytes.Length - 12)
        {
            var length = BinaryPrimitives.ReadUInt32BigEndian(bytes[offset..]);
            if (length > bytes.Length - offset - 12) { return (0, 0); }
            var size = (int)length;
            var kind = bytes.Slice(offset + 4, 4);
            var chunk = bytes.Slice(offset + 4, size + 4);
            uint crc = uint.MaxValue;
            foreach (var value in chunk)
            {
                crc ^= value;
                for (var bit = 0; bit < 8; bit++) { crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xedb88320u : 0); }
            }
            if (~crc != BinaryPrimitives.ReadUInt32BigEndian(bytes[(offset + size + 8)..])) { return (0, 0); }
            if (offset == 8)
            {
                if (!kind.SequenceEqual("IHDR"u8) || size != 13) { return (0, 0); }
                width = BinaryPrimitives.ReadInt32BigEndian(bytes[(offset + 8)..]);
                height = BinaryPrimitives.ReadInt32BigEndian(bytes[(offset + 12)..]);
            }
            else if (kind.SequenceEqual("IHDR"u8)) { return (0, 0); }
            if (kind.SequenceEqual("acTL"u8) || kind.SequenceEqual("fcTL"u8) || kind.SequenceEqual("fdAT"u8)) { return (0, 0); }
            if (kind.SequenceEqual("IDAT"u8) && size > 0) { pixels = true; }
            offset += size + 12;
            if (kind.SequenceEqual("IEND"u8)) { return pixels && size == 0 && offset == bytes.Length ? (width, height) : (0, 0); }
        }
        return (0, 0);
    }

    private static (int, int) Jpeg(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 4 || bytes[0] != 255 || bytes[1] != 216 || bytes[^2] != 255 || bytes[^1] != 217) { return (0, 0); }
        var offset = 2;
        var width = 0;
        var height = 0;
        // Walk bounded marker segments so embedded metadata cannot masquerade as the frame dimensions
        while (offset < bytes.Length - 2)
        {
            if (bytes[offset++] != 255) { return (0, 0); }
            while (offset < bytes.Length && bytes[offset] == 255) { offset++; }
            if (offset >= bytes.Length) { return (0, 0); }
            var marker = bytes[offset++];
            if (marker is 0 or 216 or 217) { return (0, 0); }
            if (offset > bytes.Length - 2) { return (0, 0); }
            var size = BinaryPrimitives.ReadUInt16BigEndian(bytes[offset..]);
            if (size < 2 || size > bytes.Length - offset) { return (0, 0); }
            if (marker is 192 or 193 or 194)
            {
                if (size < 8) { return (0, 0); }
                height = BinaryPrimitives.ReadUInt16BigEndian(bytes[(offset + 3)..]);
                width = BinaryPrimitives.ReadUInt16BigEndian(bytes[(offset + 5)..]);
            }
            if (marker == 218) { return width > 0 && offset + size < bytes.Length - 2 ? (width, height) : (0, 0); }
            offset += size;
        }
        return (0, 0);
    }

    private static (int, int) Webp(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 26 || !bytes[..4].SequenceEqual("RIFF"u8) || !bytes.Slice(8, 4).SequenceEqual("WEBP"u8)
            || BinaryPrimitives.ReadUInt32LittleEndian(bytes[4..]) != bytes.Length - 8) { return (0, 0); }
        var offset = 12;
        var width = 0;
        var height = 0;
        var pixels = false;
        var canvasWidth = 0;
        var canvasHeight = 0;
        while (offset <= bytes.Length - 8)
        {
            var kind = bytes.Slice(offset, 4);
            var size = BinaryPrimitives.ReadUInt32LittleEndian(bytes[(offset + 4)..]);
            if (size > bytes.Length - offset - 8) { return (0, 0); }
            var chunk = bytes.Slice(offset + 8, (int)size);
            if (kind.SequenceEqual("ANIM"u8) || kind.SequenceEqual("ANMF"u8)) { return (0, 0); }
            if (kind.SequenceEqual("VP8X"u8))
            {
                if (size != 10 || offset != 12) { return (0, 0); }
                // Animated containers need separate frame budgets and are not project covers
                if ((chunk[0] & 2) != 0) { return (0, 0); }
                canvasWidth = 1 + chunk[4] + (chunk[5] << 8) + (chunk[6] << 16);
                canvasHeight = 1 + chunk[7] + (chunk[8] << 8) + (chunk[9] << 16);
            }
            else if (kind.SequenceEqual("VP8L"u8) && size >= 5 && chunk[0] == 47 && (chunk[4] >> 5) == 0)
            {
                width = 1 + chunk[1] + ((chunk[2] & 63) << 8);
                height = 1 + (chunk[2] >> 6) + (chunk[3] << 2) + ((chunk[4] & 15) << 10);
                pixels = true;
            }
            else if (kind.SequenceEqual("VP8 "u8) && size >= 10 && (chunk[0] & 1) == 0 && chunk.Slice(3, 3).SequenceEqual(new byte[] { 157, 1, 42 }))
            {
                width = BinaryPrimitives.ReadUInt16LittleEndian(chunk[6..]) & 0x3fff;
                height = BinaryPrimitives.ReadUInt16LittleEndian(chunk[8..]) & 0x3fff;
                pixels = true;
            }
            var padded = (long)offset + 8 + size + (size & 1);
            if (padded > bytes.Length) { return (0, 0); }
            offset = (int)padded;
        }
        // Extended canvas metadata must agree with the actual frame before applying the decoded-pixel budget
        return pixels && offset == bytes.Length && (canvasWidth == 0 || (canvasWidth == width && canvasHeight == height))
            ? (width, height) : (0, 0);
    }
}
