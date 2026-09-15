const configuration: Configuration = {
    agents: [
        {
            name: 'claude',
            command: 'claude',
            arguments: ['-p', 'Hello, claude!']
        },
        {
            name: 'codex',
            command: 'codex',
            arguments: ['-p', 'Hello, codex!'],
        }
    ]
};