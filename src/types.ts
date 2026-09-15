type Agent = {
    name: string,
    command: string,
    arguments: string[]
}

type Configuration = {
    agents: Agent[],
}

export {
    Agent,
    Configuration
};