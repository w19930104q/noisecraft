import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { assert } from './public/utils.js';
import * as model from './public/model.js';
import { compile } from './public/compiler.js';
import { AudioGraph } from './public/audiograph.js';

function assertThrows(fn)
{
    let throws = false;

    try
    {
        fn();
    }
    catch (e)
    {
        throws = true;
    }

    assert (throws);
}

// Test username validation
{
    assert (typeof model.MAX_USERNAME_LENGTH == 'number');

    model.validateUserName('Foo');
    model.validateUserName('el');
    model.validateUserName('Foo_bar2');
    model.validateUserName('Foo Bar 2');
    model.validateUserName('_Long_User_Name_');

    // Invalid usernames
    assertThrows(_ => model.validateUserName(' foo '));
    assertThrows(_ => model.validateUserName('foo)'));
    assertThrows(_ => model.validateUserName(''));
    assertThrows(_ => model.validateUserName('overly long username foobar'));
}

// Test CreateNode
{
    var m = new model.Model();
    m.new();
    m.update(new model.CreateNode('AudioOut', 0, 0));
    assert (m.hasNode('AudioOut'));
    m.serialize();
}

// Test undo/redo and SetParam
{
    var m = new model.Model();
    m.new();
    let knobId = m.update(new model.CreateNode('Knob', 0, 0));
    m.update(new model.DeleteNodes([knobId]));
    m.undo();
    assert (m.hasNode('Knob'));
    m.redo();
    m.undo();
    m.update(new model.SetParam(knobId, "value", 0.5));
    m.serialize();
}

// Test copy/paste
{
    var m = new model.Model();
    m.new();
    let knob0 = m.update(new model.CreateNode('Knob', 0, 0));
    let knob1 = m.update(new model.CreateNode('Knob', 10, 10));
    var data = m.copy([knob0, knob1]);
    m.update(new model.Paste(data, 20, 20));
    assert (m.numNodes == 4);
}

// Test grouping
{
    var m = new model.Model();
    m.new();
    m.update(new model.CreateNode('Add', 0, 0));
    m.update(new model.CreateNode('Add', 10, 10));
    m.update(new model.ConnectNodes("0", 1, "1", 0));
    m.update(new model.GroupNodes(["1"]));
    assert (m.numNodes == 2);
}

// Try loading all of our example projects
fs.readdirSync('examples').forEach(fileName =>
{
    // Read the example file
    let filePath = path.join('examples', fileName);
    console.log(filePath);
    let data = fs.readFileSync(filePath, 'utf8')

    // Test deserialization
    let m = new model.Model();
    m.deserialize(data);

    // Test serialization
    let out = m.serialize();
    assert (out.length > 0);

    // Test the compiler
    let unit = compile(m.state);
    let genSample = new Function(
        'time',
        'nodes',
        unit.src
    );
});

// Expected PCM hash for the offline rendering test below, captured
// from the original audio graph implementation. This must remain
// identical as long as audio module semantics are unchanged.
const EXPECTED_PCM_HASH = 'b87ec24afba376c59e6d2f981af1a325742377b259180ba1bbd7c9fe25189c32';

// Offline rendering test: live param tweaks must not glitch the audio
// stream, failed compilations must not leave stale nodes behind, and
// stopping playback must release all nodes and connections
{
    // Build a fixed patch:
    //   Const(freq)  -> Sine.freq
    //   Sine         -> Filter.in
    //   Const(cut)   -> Filter.cutoff
    //   Filter       -> Delay.in, Const(time) -> Delay.time
    //   Filter       -> AudioOut.left, Delay -> AudioOut.right
    let m = new model.Model();
    m.new();

    let audioOutId = m.update(new model.CreateNode('AudioOut', 0, 0));
    let sineId = m.update(new model.CreateNode('Sine', 0, 0));
    let freqId = m.update(new model.CreateNode('Const', 0, 0));
    let cutoffId = m.update(new model.CreateNode('Const', 0, 0));
    let filterId = m.update(new model.CreateNode('Filter', 0, 0));
    let delayId = m.update(new model.CreateNode('Delay', 0, 0));
    let delayTimeId = m.update(new model.CreateNode('Const', 0, 0));

    m.update(new model.SetParam(freqId, 'value', 220));
    m.update(new model.SetParam(cutoffId, 'value', 0.5));
    m.update(new model.SetParam(delayTimeId, 'value', 0.1));

    m.update(new model.ConnectNodes(freqId, 0, sineId, 0));
    m.update(new model.ConnectNodes(sineId, 0, filterId, 0));
    m.update(new model.ConnectNodes(cutoffId, 0, filterId, 1));
    m.update(new model.ConnectNodes(filterId, 0, delayId, 0));
    m.update(new model.ConnectNodes(delayTimeId, 0, delayId, 1));
    m.update(new model.ConnectNodes(filterId, 0, audioOutId, 0));
    m.update(new model.ConnectNodes(delayId, 0, audioOutId, 1));

    // Number of stateful audio nodes in this patch
    // (3 x Const, Sine, Filter, Delay)
    const numAudioNodes = 6;

    let graph = new AudioGraph(44100, () => {});

    // Simulate the audio view: compile and swap in the initial unit
    graph.parseMsg({ type: 'NEW_UNIT', unit: compile(m.state) });

    // Render offline, applying three consecutive param modifications
    // mid-stream, each one followed by a full recompile from the root
    const blockLen = 4096;
    let pcm = new Float32Array(2 * blockLen * 4);
    let offset = 0;

    function renderBlock()
    {
        for (let i = 0; i < blockLen; ++i)
        {
            let [left, right] = graph.genSample();
            pcm[offset++] = left;
            pcm[offset++] = right;
        }
    }

    renderBlock();

    for (let cutoff of [0.9, 0.2, 0.6])
    {
        // Live param tweak (message path used while playing)
        m.update(new model.SetParam(cutoffId, 'value', cutoff));
        graph.parseMsg({
            type: 'SET_PARAM',
            nodeId: cutoffId,
            paramName: 'value',
            value: cutoff
        });

        // Full recompile from the root, as triggered by graph edits
        graph.parseMsg({ type: 'NEW_UNIT', unit: compile(m.state) });

        renderBlock();
    }

    // Hash the rendered PCM, this must remain identical as long as
    // the semantics of the audio modules are unchanged
    let pcmHash = createHash('sha256')
        .update(Buffer.from(pcm.buffer))
        .digest('hex');
    console.log('offline render PCM hash:', pcmHash);
    assert (
        pcmHash == EXPECTED_PCM_HASH,
        'PCM hash mismatch, audio semantics changed'
    );

    // Param tweaks must reuse existing nodes, not recreate them
    if (graph.stats)
    {
        assert (
            graph.stats.nodesCreated == numAudioNodes,
            'param tweaks must not recreate audio nodes'
        );
        assert (
            graph.stats.nodesDisposed == 0,
            'no nodes should be disposed while playing'
        );
    }

    // A failed/cancelled compilation must leave the current snapshot
    // untouched and must not leave stale nodes behind
    {
        let badUnit = compile(m.state);
        badUnit.src = 'this is not valid javascript (';

        // The bad unit references a node id that does not exist yet
        badUnit.nodes['999'] = {
            type: 'Sine',
            params: { minVal: -1, maxVal: 1 }
        };

        assertThrows(_ => graph.parseMsg({ type: 'NEW_UNIT', unit: badUnit }));

        // The previous snapshot must still render correctly
        let [left, right] = graph.genSample();
        assert (typeof left == 'number' && typeof right == 'number');

        if (graph.stats)
        {
            assert (
                graph.stats.nodesCreated == numAudioNodes,
                'failed compilation must not create stale nodes'
            );
            assert (
                graph.stats.nodesDisposed == 0,
                'failed compilation must not dispose live nodes'
            );
        }
    }

    // Stopping playback must release all nodes and connections
    if (graph.stop)
    {
        graph.stop();

        assert (
            graph.stats.nodesDisposed == numAudioNodes,
            'all nodes must be disposed when playback stops'
        );

        // After stopping, the graph renders silence
        let [left, right] = graph.genSample();
        assert (left == 0 && right == 0);
    }
}
