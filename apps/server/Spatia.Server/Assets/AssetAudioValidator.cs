using System.Buffers.Binary;

namespace Spatia.Server.Assets;

/// <summary>Checks an unfragmented, self-contained AAC/M4A before admitting it to the catalogue</summary>
internal static class AssetAudioValidator
{
    private readonly record struct Box(uint Type, int Payload, int End);
    private const uint Ftyp = 0x66747970, Moov = 0x6d6f6f76, Mdat = 0x6d646174, Moof = 0x6d6f6f66;
    private const uint Trak = 0x7472616b, Mdia = 0x6d646961, Hdlr = 0x68646c72, Minf = 0x6d696e66;
    private const uint Dinf = 0x64696e66, Dref = 0x64726566, Url = 0x75726c20, Stbl = 0x7374626c;
    private const uint Stsd = 0x73747364, Mp4a = 0x6d703461, Esds = 0x65736473, Stts = 0x73747473;
    private const uint Stsc = 0x73747363, Stsz = 0x7374737a, Stco = 0x7374636f, Co64 = 0x636f3634;

    public static (bool Valid, string[] Messages) Validate(byte[] bytes)
    {
        var valid = IsValid(bytes);
        return (valid, valid ? [] : ["File is not a supported self-contained AAC/M4A audio file"]);
    }

    private static bool IsValid(ReadOnlySpan<byte> bytes)
    {
        // Only bounded, complete boxes are visited; fragmented MP4 and multiple tracks are outside this intake
        if (bytes.Length is < 32 or > AssetIntakePolicy.MaxBytes) { return false; }
        var media = new List<Box>();
        Box fileType = default, movie = default;
        var position = 0;
        while (position < bytes.Length)
        {
            if (!ReadBox(bytes, position, bytes.Length, out var box)) { return false; }
            if (box.Type == Ftyp) { if (fileType.End != 0 || position != 0) { return false; } fileType = box; }
            else if (box.Type == Moov) { if (movie.End != 0) { return false; } movie = box; }
            else if (box.Type == Mdat) { if (box.End == box.Payload || media.Count == 32) { return false; } media.Add(box); }
            else if (box.Type == Moof) { return false; }
            position = box.End;
        }
        if (fileType.End - fileType.Payload < 8 || movie.End == 0 || media.Count == 0
            || !Find(bytes, movie, Trak, out var track) || !Find(bytes, track, Mdia, out var metadata)
            || !Find(bytes, metadata, Hdlr, out var handler) || handler.End - handler.Payload < 12
            || Read32(bytes, handler.Payload + 8) != 0x736f756e // soun
            || !Find(bytes, metadata, Minf, out var information) || !SelfContained(bytes, information)
            || !Find(bytes, information, Stbl, out var samples)) { return false; }

        // A normal MP4 brand must be present in the major or compatible brand list
        var supportedBrand = false;
        for (var offset = fileType.Payload; offset + 4 <= fileType.End; offset += 4)
        {
            if (offset == fileType.Payload + 4) { continue; } // minor version is not a brand
            supportedBrand |= Read32(bytes, offset) is 0x4d344120 or 0x69736f6d or 0x69736f32 or 0x6d703431 or 0x6d703432;
        }
        return supportedBrand && AudioSampleDescription(bytes, samples) && SampleLocations(bytes, samples, media);
    }

    private static bool SelfContained(ReadOnlySpan<byte> bytes, Box information)
    {
        // Reject references to external media: every sample must belong to this upload
        if (!Find(bytes, information, Dinf, out var dataInformation) || !Find(bytes, dataInformation, Dref, out var references)
            || references.End - references.Payload < 8 || Read32(bytes, references.Payload + 4) != 1
            || !ReadBox(bytes, references.Payload + 8, references.End, out var reference)
            || reference.Type != Url || reference.End != references.End || reference.End - reference.Payload != 4)
        { return false; }
        return Read32(bytes, reference.Payload) == 1;
    }

    private static bool AudioSampleDescription(ReadOnlySpan<byte> bytes, Box samples)
    {
        if (!Find(bytes, samples, Stsd, out var descriptions) || descriptions.End - descriptions.Payload < 8
            || Read32(bytes, descriptions.Payload + 4) != 1
            || !ReadBox(bytes, descriptions.Payload + 8, descriptions.End, out var entry)
            || entry.Type != Mp4a || entry.End != descriptions.End || entry.End - entry.Payload < 28
            || Read16(bytes, entry.Payload + 6) != 1 || Read16(bytes, entry.Payload + 8) != 0
            || Read16(bytes, entry.Payload + 16) == 0 || Read32(bytes, entry.Payload + 24) == 0)
        { return false; }

        // mp4a needs an elementary stream description; its payload is decoded by the browser
        var nested = new Box(0, entry.Payload + 28, entry.End);
        return Find(bytes, nested, Esds, out var codec) && codec.End - codec.Payload >= 8;
    }

    private static bool SampleLocations(ReadOnlySpan<byte> bytes, Box samples, List<Box> media)
    {
        if (!Find(bytes, samples, Stsz, out var sizes) || sizes.End - sizes.Payload < 12
            || !Find(bytes, samples, Stsc, out var chunks) || chunks.End - chunks.Payload < 8
            || !Find(bytes, samples, Stts, out var times) || times.End - times.Payload < 8)
        { return false; }
        var sampleSize = Read32(bytes, sizes.Payload + 4);
        var sampleCount = Read32(bytes, sizes.Payload + 8);
        var groupCount = Read32(bytes, chunks.Payload + 4);
        var timeCount = Read32(bytes, times.Payload + 4);
        if (sampleCount is 0 or > 1_000_000 || groupCount is 0 or > 1_000_000 || timeCount is 0 or > 1_000_000
            || (sampleSize == 0 && (long)sampleCount * 4 > sizes.End - sizes.Payload - 12)
            || (long)groupCount * 12 > chunks.End - chunks.Payload - 8
            || (long)timeCount * 8 > times.End - times.Payload - 8) { return false; }

        // Timing and chunk tables must account for the same samples as the size table
        ulong timedSamples = 0;
        for (var i = 0; i < timeCount; i++)
        {
            var offset = times.Payload + 8 + i * 8;
            if (Read32(bytes, offset) == 0 || Read32(bytes, offset + 4) == 0) { return false; }
            timedSamples += Read32(bytes, offset);
        }
        if (timedSamples != sampleCount) { return false; }

        var has32 = TryFind(bytes, samples, Stco, out var offsets32, out var found32);
        var has64 = TryFind(bytes, samples, Co64, out var offsets64, out var found64);
        if (!has32 || !has64 || found32 == found64) { return false; }
        var offsets = found32 ? offsets32 : offsets64;
        var width = found32 ? 4 : 8;
        if (offsets.End - offsets.Payload < 8) { return false; }
        var chunkCount = Read32(bytes, offsets.Payload + 4);
        if (chunkCount is 0 or > 1_000_000 || groupCount > chunkCount
            || (long)chunkCount * width > offsets.End - offsets.Payload - 8) { return false; }

        uint previousFirst = 0;
        for (var i = 0; i < groupCount; i++)
        {
            var offset = chunks.Payload + 8 + i * 12;
            var first = Read32(bytes, offset);
            if (first <= previousFirst || first > chunkCount || (i == 0 && first != 1)
                || Read32(bytes, offset + 4) == 0 || Read32(bytes, offset + 8) != 1) { return false; }
            previousFirst = first;
        }

        // Check every chunk and sample count against the actual media payload, not just MP4 signatures
        uint group = 0, sample = 0;
        for (uint chunk = 1; chunk <= chunkCount; chunk++)
        {
            while (group + 1 < groupCount && Read32(bytes, chunks.Payload + 8 + (int)(group + 1) * 12) <= chunk) { group++; }
            var count = Read32(bytes, chunks.Payload + 12 + (int)group * 12);
            if (count > sampleCount - sample) { return false; }
            ulong length = 0;
            for (var i = 0; i < count; i++)
            {
                var size = sampleSize == 0 ? Read32(bytes, sizes.Payload + 12 + (int)(sample + i) * 4) : sampleSize;
                if (size == 0) { return false; }
                length += size;
            }
            sample += count;
            var entry = offsets.Payload + 8 + (int)(chunk - 1) * width;
            var start = found32 ? Read32(bytes, entry) : Read64(bytes, entry);
            if (!media.Any(box => start >= (ulong)box.Payload && start <= (ulong)box.End
                && length <= (ulong)box.End - start)) { return false; }
        }
        return sample == sampleCount;
    }

    private static bool Find(ReadOnlySpan<byte> bytes, Box parent, uint type, out Box result) =>
        TryFind(bytes, parent, type, out result, out var found) && found;

    private static bool TryFind(ReadOnlySpan<byte> bytes, Box parent, uint type, out Box result, out bool found)
    {
        result = default;
        found = false;
        for (var position = parent.Payload; position < parent.End;)
        {
            if (!ReadBox(bytes, position, parent.End, out var box)) { return false; }
            if (box.Type == type) { if (found) { return false; } found = true; result = box; }
            position = box.End;
        }
        return true;
    }

    private static bool ReadBox(ReadOnlySpan<byte> bytes, int position, int end, out Box box)
    {
        box = default;
        if (position < 0 || end > bytes.Length || end - position < 8) { return false; }
        ulong size = Read32(bytes, position);
        var header = 8;
        if (size == 1)
        {
            if (end - position < 16) { return false; }
            size = Read64(bytes, position + 8);
            header = 16;
        }
        if (size == 0) { size = (ulong)(end - position); }
        if (size < (ulong)header || size > (ulong)(end - position)) { return false; }
        box = new Box(Read32(bytes, position + 4), position + header, position + (int)size);
        return true;
    }

    private static ushort Read16(ReadOnlySpan<byte> bytes, int offset) => BinaryPrimitives.ReadUInt16BigEndian(bytes.Slice(offset, 2));
    private static uint Read32(ReadOnlySpan<byte> bytes, int offset) => BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(offset, 4));
    private static ulong Read64(ReadOnlySpan<byte> bytes, int offset) => BinaryPrimitives.ReadUInt64BigEndian(bytes.Slice(offset, 8));
}
