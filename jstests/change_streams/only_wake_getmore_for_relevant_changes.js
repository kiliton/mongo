// Test that an insert to an unrelated collection will not cause a $changeStream getMore to
// return early.
(function() {
    "use strict";

    load('jstests/libs/uuid_util.js');
    load("jstests/libs/fixture_helpers.js");  // For 'FixtureHelpers'.

    /**
     * Uses a parallel shell to execute the javascript function 'event' at the same time as an
     * awaitData getMore on the cursor with id 'awaitDataCursorId'. Returns the result of the
     * getMore, and the time it took to complete.
     *
     * Note that 'event' will not have access to any local variables, since it will be executed in a
     * different scope.
     */
    function runGetMoreInParallelWithEvent({collection, awaitDataCursorId, maxTimeMS, event}) {
        // In some extreme cases, the parallel shell can take longer to start up than it takes for
        // the getMore to run. To prevent this from happening, the main thread waits for an insert
        // into "sentinel", to signal that the parallel shell has started and is waiting for the
        // getMore to appear in currentOp.
        const shellSentinelCollection = db.shell_sentinel;
        shellSentinelCollection.drop();

        const awaitShellDoingEventDuringGetMore =
            startParallelShell(`
// Signal that the parallel shell has started.
assert.writeOK(db.getCollection("${ shellSentinelCollection.getName() }").insert({}));

// Wait for the getMore to appear in currentOp.
assert.soon(function() {
    return db.currentOp({op: "getmore", "command.collection": "${collection.getName()}"})
               .inprog.length === 1;
});

const eventFn = ${ event.toString() };
eventFn();`,
                               FixtureHelpers.getPrimaryForNodeHostingDatabase(db).port);

        // Wait for the shell to start.
        assert.soon(() => shellSentinelCollection.findOne() != null);

        // Run and time the getMore.
        const startTime = (new Date()).getTime();
        const result = assert.commandWorked(db.runCommand(
            {getMore: awaitDataCursorId, collection: collection.getName(), maxTimeMS: maxTimeMS}));
        awaitShellDoingEventDuringGetMore();
        return {result: result, elapsedMs: (new Date()).getTime() - startTime};
    }

    /**
     * Asserts that a getMore of the cursor given by 'awaitDataCursorId' will not return after
     * 'event' is called, and will instead keep waiting until its maxTimeMS is expired.
     *
     * @param [Collection] collection - the collection to use in the getMore command.
     * @param [NumberLong] awaitDataCursorId - the id of the cursor to use in the getMore command.
     * @param [Function] event - the event that should be run during the getMore.
     */
    function assertEventDoesNotWakeCursor({collection, awaitDataCursorId, event}) {
        const {result, elapsedMs} = runGetMoreInParallelWithEvent({
            collection: collection,
            awaitDataCursorId: awaitDataCursorId,
            maxTimeMS: 1000,
            event: event,
        });
        // Should have waited for at least 'maxTimeMS'.
        assert.gt(elapsedMs, 900, "getMore returned before waiting for maxTimeMS");
        const cursorResponse = result.cursor;
        // Cursor should be valid with no data.
        assert.neq(cursorResponse.id, 0);
        assert.eq(cursorResponse.nextBatch.length, 0);
    }

    /**
     * Asserts that a getMore of the cursor given by 'awaitDataCursorId' will return soon after
     * 'event' is called, and returns the response from the getMore command.
     *
     * @param [Collection] collection - the collection to use in the getMore command.
     * @param [NumberLong] awaitDataCursorId - the id of the cursor to use in the getMore command.
     * @param [Function] event - the event that should be run during the getMore.
     */
    function assertEventWakesCursor({collection, awaitDataCursorId, event}) {
        // Run the original event, then (while still in the parallel shell) assert that the getMore
        // finishes soon after. This will be run in a parallel shell, which will not have a variable
        // 'event' in scope, so we'll have to stringify it here.
        const thirtyMinutes = 30 * 60 * 1000;
        const fiveMinutes = 5 * 60 * 1000;
        const {result, elapsedMs} = runGetMoreInParallelWithEvent({
            collection: collection,
            awaitDataCursorId: awaitDataCursorId,
            maxTimeMS: thirtyMinutes,
            event: event,
        });

        assert.lt(elapsedMs, fiveMinutes);

        return result;
    }

    const changesCollection = db.changes;
    changesCollection.drop();
    assert.commandWorked(db.createCollection(changesCollection.getName()));

    // Start a change stream cursor.
    let res = assert.commandWorked(db.runCommand({
        aggregate: changesCollection.getName(),
        // Project out the timestamp, since that's subject to change unpredictably.
        pipeline: [{$changeStream: {}}, {$project: {"_id.clusterTime": 0}}],
        cursor: {}
    }));
    const changeCursorId = res.cursor.id;
    assert.neq(changeCursorId, 0);
    assert.eq(res.cursor.firstBatch.length, 0);

    // Test that an insert during a getMore will wake up the cursor and immediately return with the
    // new result.
    const getMoreResponse = assertEventWakesCursor({
        collection: changesCollection,
        awaitDataCursorId: changeCursorId,
        event: () => assert.writeOK(db.changes.insert({_id: "wake up"}))
    });
    assert.eq(getMoreResponse.cursor.nextBatch.length, 1);
    const changesCollectionUuid = getUUIDFromListCollections(db, changesCollection.getName());
    assert.docEq(getMoreResponse.cursor.nextBatch[0], {
        _id: {documentKey: {_id: "wake up"}, uuid: changesCollectionUuid},
        documentKey: {_id: "wake up"},
        fullDocument: {_id: "wake up"},
        ns: {db: db.getName(), coll: changesCollection.getName()},
        operationType: "insert"
    });

    // Test that an insert to an unrelated collection will not cause the change stream to wake up
    // and return an empty batch before reaching the maxTimeMS.
    db.unrelated_collection.drop();
    assertEventDoesNotWakeCursor({
        collection: changesCollection,
        awaitDataCursorId: changeCursorId,
        event: () => assert.writeOK(db.unrelated_collection.insert({_id: "unrelated change"}))
    });

    // Test that changes ignored by filtering in later stages of the pipeline will not cause the
    // cursor to return before the getMore has exceeded maxTimeMS.
    res = assert.commandWorked(db.runCommand({
        aggregate: changesCollection.getName(),
        // This pipeline filters changes to only invalidates, so regular inserts should not cause
        // the awaitData to end early.
        pipeline: [{$changeStream: {}}, {$match: {operationType: "invalidate"}}],
        cursor: {}
    }));
    assert.eq(
        res.cursor.firstBatch.length, 0, "did not expect any invalidations on changes collection");
    assert.neq(res.cursor.id, 0);
    assertEventDoesNotWakeCursor({
        collection: changesCollection,
        awaitDataCursorId: res.cursor.id,
        event: () => assert.writeOK(db.changes.insert({_id: "should not appear"}))
    });
}());
