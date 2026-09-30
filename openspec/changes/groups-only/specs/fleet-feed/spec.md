# fleet-feed

0.7.0 (#173): the feed of the fleet goes; a group is read in its tab, an agent in its tab.

## REMOVED Requirements

### Requirement: The Fleet section has a feed of every message

**Reason**: With isolation by chat (#172) every message is read in one place, and the feed was the
third place the person read the same exchange in (#173). A feed per group is the tab of the group; a
feed of the person and the agents is the tab of the agent, N times.

**Migration**: None on disk or on the socket. `web/src/fleet-feed.ts`, `FleetFeedPanel.tsx`, their story
and tests, the filter by agent, the jump from a row (`feedOpen`), the `_feed` id and `feedId`, the i18n
keys `sidebar.allMessages*` and `fleetFeed.*`, the e2e of #114 and the README paragraph are removed.
`group` on the `message` event stays — isolation needs it.
