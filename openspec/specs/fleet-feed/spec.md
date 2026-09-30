# fleet-feed

## Purpose

The feed of the fleet as built in 0.5–0.6.x (#114): the «All messages» tab of the Fleet section, one
feed of every message of the fleet for the person to read, with a filter by agent and a jump from a row
to the tab it lives in. This spec is the record 0.7.0 removes (#173).

## Requirements

### Requirement: The Fleet section has a feed of every message

The dashboard SHALL show, under **All messages** in the Fleet section (`_feed`), every message of the
fleet in one lane — the person's, the agents', tasks and forwards with their tags — with chips to filter
by agent and a jump from a row to the tab the message lives in. A message to a group SHALL be one row,
not one per member: who wrote it → the name of the group, with the group as the tag, and a click opens
the tab of the group at that message; the filter by agent matches a group message an agent wrote or got.

#### Scenario: A group message in the feed

- **WHEN** eva posts to group `release` of three members
- **THEN** the feed has one row, eva → Release, tagged with the group, and a click on it opens the tab
  of the group at that message

#### Scenario: The filter by agent

- **WHEN** the person ticks eva in the chips of the feed
- **THEN** the feed shows the messages eva wrote or got, group messages included
