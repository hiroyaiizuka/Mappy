<!-- Basic Memory 公式のナレッジフォーマット定義。mappy-memory のノートもこの形式に従う。プロジェクト固有の内容はここに書かず SKILL.md 側に置く。 -->

# Knowledge Format - Basic Memory

Understanding how Basic Memory structures knowledge will help you create richer, more connected notes. Here's how the semantic patterns work.

File-First Architecture
-----------------------

All knowledge in Basic Memory is stored in plain text Markdown files:

*   Files are the source of truth for all knowledge in Basic Memory
*   Changes to files automatically update the knowledge graph in the db
*   You maintain complete ownership and control
*   Files work with git and other version control systems
*   Knowledge persists independently of any AI conversation

Core Document Structure
-----------------------

Every document uses this basic structure:

```
---
title: Document Title
type: note
tags: [tag1, tag2]
permalink: custom-path
---

# Document Title
Regular markdown content...

## Observations
- [category] Content with #tags (optional context)

## Relations
- relation_type [[Other Document]] (optional context)
```

### Frontmatter

The YAML frontmatter at the top of each file defines essential metadata:

```
---
title: Document Title    # Used for linking and references
type: note               # Document type
tags: [tag1, tag2]       # For organization and searching
permalink: custom-link   # Optional custom URL path
---
```

The title is particularly important as it's used to create links between documents.

### Observations

Observations are facts or statements about a topic:

```
- [tech] Uses SQLite for storage #database
- [design] Follows local-first architecture #architecture
- [decision] Selected bcrypt for passwords #security (Based on audit)
```

Observations are markdown list items beginning with a `[category]` value. Basic Memory knows not to treat Markdown checkbox lists (`[ ]` or `[x]`) as observations.

Each observation contains:

*   **Category** in [brackets] - classifies the information type
*   **Content text** - the main information
*   Optional **#tags** - additional categorization
*   Optional **(context)** - supporting details

### Common Categories

*   `[tech]`: Technical details
*   `[design]`: Architecture decisions
*   `[feature]`: User capabilities
*   `[decision]`: Choices that were made

### Additional Categories

*   `[principle]`: Fundamental concepts
*   `[method]`: Approaches or techniques
*   `[preference]`: Personal opinions

### Relations

Relations connect documents to form the knowledge graph:

```
- implements [[Search Design]]
- depends_on [[Database Schema]]
- relates_to [[User Interface]]
```

Relations are markdown list items beginning with a descriptive word, followed by a `[[wiki link]]` value. The description is used as the relationship type.

You can also create inline references:

`This builds on [[Core Design]] and uses [[Utility Functions]].`

Common relation types include:

*   `implements`: Implementation of a specification
*   `depends_on`: Required dependency
*   `relates_to`: General connection
*   `inspired_by`: Source of ideas
*   `extends`: Enhancement
*   `part_of`: Component relationship
*   `contains`: Hierarchical relationship
*   `pairs_with`: Complementary relationship

Knowledge Graph
---------------

Basic Memory automatically builds a knowledge graph from your document connections:

*   Each document becomes a node in the graph
*   Relations create edges between nodes
*   Relation types add semantic meaning to connections
*   Forward references can link to documents that don't exist yet

This graph enables rich context building and navigation across your knowledge base.

Permalinks and memory:// URLs
-----------------------------

Every document in Basic Memory has a unique **permalink** that serves as its stable identifier:

*   Set explicitly in the frontmatter (`permalink: folder/note-name`), or generated from the folder and title when omitted
*   Used to reference the note from `bm tool read-note <permalink> --project mappy-memory` and from `[[wiki links]]` in other notes
*   Stable across edits to the note's content — renaming the title does not change the permalink unless the frontmatter is edited
*   Addressable inside Basic Memory as a `memory://<permalink>` URL, used internally to resolve relations and build context

mappy-memory の permalink はカテゴリを含める（例: `bugfixes/2026-09-22-paste-image-node-not-found`）。ファイル名と permalink の対応が崩れると `bm tool search-notes` や `[[wiki link]]` からたどれなくなる。
