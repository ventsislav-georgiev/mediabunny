import { expect, test } from 'vitest';
import path from 'node:path';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { extractAv1SequenceHeaderOBU, iterateAv1PacketObus } from '../../src/codec-data.js';

const __dirname = new URL('.', import.meta.url).pathname;

test('Matroska muxer internally converts ADTS to AAC', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	expect(inputDecoderConfig!.description).toBeUndefined(); // ADTS input has no description

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	expect(await outputTrack.getCodec()).toBe('aac');
	expect(await outputTrack.getSampleRate()).toBe(await inputTrack.getSampleRate());
	expect(await outputTrack.getNumberOfChannels()).toBe(await inputTrack.getNumberOfChannels());

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeDefined();

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// Packets should NOT be ADTS frames (should not start with 0xFFF sync word)
		const isAdts = packet.data[0] === 0xff && (packet.data[1]! & 0xf0) === 0xf0;
		expect(isAdts).toBe(false);
		count++;
	}

	expect(count).toBe(4557);
});

test('AV1 sequence header extraction from valid packet', () => {
	// Create a valid AV1 packet with sequence header OBU
	// OBU header: forbidden(0) + type(1=0001) + extension(0) + has_size(1) + reserved(0) = 0x0A
	// Size: 4 bytes (LEB128 encoded as single byte 0x04)
	// Payload: 4 bytes of sequence header data
	const sequenceHeaderPayload = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
	const packet = new Uint8Array([0x0A, 0x04, ...sequenceHeaderPayload]);

	const result = extractAv1SequenceHeaderOBU(packet);

	expect(result).not.toBeNull();
	expect(result![0]).toBe(0x0A); // OBU header with has_size=1
	expect(result![1]).toBe(0x04); // Size field (LEB128)
	expect(result!.slice(2)).toEqual(sequenceHeaderPayload); // Payload
});

test('AV1 sequence header extraction with multiple OBUs', () => {
	// Create a packet with sequence header OBU followed by frame OBU
	const sequenceHeaderPayload = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
	const framePayload = new Uint8Array([0x02, 0x03, 0x04]);

	// Sequence header OBU: 0x0A (header) + 0x04 (size) + payload
	// Frame OBU: 0x32 (type=6, has_size=1) + 0x03 (size) + payload
	const packet = new Uint8Array([
		0x0A, 0x04, ...sequenceHeaderPayload,
		0x32, 0x03, ...framePayload,
	]);

	const result = extractAv1SequenceHeaderOBU(packet);

	expect(result).not.toBeNull();
	expect(result![0]).toBe(0x0A);
	expect(result![1]).toBe(0x04);
	expect(result!.slice(2)).toEqual(sequenceHeaderPayload);
});

test('AV1 sequence header extraction returns null when not found', () => {
	// Create a packet with only frame OBU (no sequence header)
	const framePayload = new Uint8Array([0x02, 0x03, 0x04]);
	const packet = new Uint8Array([0x32, 0x03, ...framePayload]);

	const result = extractAv1SequenceHeaderOBU(packet);

	expect(result).toBeNull();
});

test('AV1 OBU iteration correctly parses packet structure', () => {
	// Verify that iterateAv1PacketObus correctly identifies OBU types
	const sequenceHeaderPayload = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
	const framePayload = new Uint8Array([0x02, 0x03, 0x04]);

	const packet = new Uint8Array([
		0x0A, 0x04, ...sequenceHeaderPayload,
		0x32, 0x03, ...framePayload,
	]);

	const obus = Array.from(iterateAv1PacketObus(packet));

	expect(obus).toHaveLength(2);
	expect(obus[0].type).toBe(1); // OBU_SEQUENCE_HEADER
	expect(obus[0].data).toEqual(sequenceHeaderPayload);
	expect(obus[1].type).toBe(6); // OBU_FRAME
	expect(obus[1].data).toEqual(framePayload);
});
