Okay, so I want you to grab the latest version of OpenRouter's SDK, and to look at the repo that I linked to below to kind of see how tool calling works using the OpenRouter SDK, and feel free to review the context 7 docs on all of that, too. And prepare a overview document that kind of summarizes exactly how to do that using your concise writing skill, inside of the output directory, inside of the output directory, inside of the output directory, inside of the output directory, inside of the output directory, inside of the output directory, and inside of the output directory. inside of Docs. And then also research Claude Code skills using your Claude Code documentation skill or whatever, and create a concise document about that. And then create a simple example app that uses Svelte, probably SvelteKit, or probably doesn't even need to be that sophisticated. that created can be just a simple back server and a simple front app Let go with Svelte for that That uses the you know best way to do Svelte stuff Svelte create and all of those things And then showcase how to essentially replicate the idea of skills in a tool Kind of what I thinking is that outlined below And then ultimately what I want to be creating so that essentially an example and I want to have a library We building a library here that makes it so that you can plug in something to OpenRouter and I think they support plugins in their SDK if not you know essentially a wrapper that makes it so that you can point to a directory of skills that you can and then optionally exposed to your agents. And then it makes it really easy to give agents skills that they can use just like they can with tools. And ideally, it uses context the exact same way as skills, where basically it just gives them the description and then they can go grab the details of the skill to know how to use the skill, which includes calling specific scripts and things like that. So it probably needs to actually give them a tool to be able to that we're able to call various scripts. I think for this version, these scripts would all be JavaScript-based, but they would need some way to be essentially calling those scripts. And ideally, the scripts are still similar to just other skills where they're just scripts that can be called via bash or whatever. And so we would essentially be giving agents the ability to make those requests, and requests to these files. Alright, let me know if you've got questions after you do your initial research. and then provide some kind of examples of the signatures that would be used to engage with these agents and what the skill folder and layouts and things might look like so I can have an idea of what you're planning to build and we can iterate on that before you go build things.

```
skills/
    discord/
        SKILL.md # standard skill format
        discord.mjs # standard skill script
```

Agent then receives summary of all skills they were given (skill name, front-matter, like normal SKILL exposure) as part of system prompt.
Agent has the following tools:
```
load-skill(skillName: string) # Gets the content of the SKILL.md without the front-matter (since that was intended for context ingestion)
use-skill(skillName: string, scriptPath: string, paramsString?: string) # Calls the specified script inside of the given skill folder with the params the agent requested
```

**Example Use**
1. Agent system prompt is injected with skills:
```
## Skills you can load
Skills give you the ability to perform important actions correctly and efficiently. Use them proactively as directed below
### {skill name/folder name of skill}
{description from front-matter of SKILL.md}

If skills reference scripts that should be run, you can call them using the `use-skill` tool available to you. For example, if the SKILL referenced calling `node ./skills/discord/discord.mjs send "message"` you can use the tool like `use-skill('discord', 'discord.mjs', 'send "message"')`
```
2. User tells agent to send a "Hello World" message to the #dev-site channel on Discord
3. Agent loads the discord skill `load-skill('discord')`
4. load-skill tool finds the corresponding skill and responds with the content of the SKILL.md (without front-matter)
5. Agent understands how to use the skill and then uses the skill `use-skill('discord', 'discord.mjs', 'channels list')` to get the channels with name and ID followed by `use-skill('discord', 'discord.mjs', 'send "Hello World" --channel=1234234234')`
6. use-skill tool finds the appropriate script and spawns a process to run the script as specified and returns the result from the call as a success or error
7. Agent confirms that they sent the message

## Reference Material
Example of tool calling in OpenRouterSDK can be found in this project: C:\Dev\Repos\ai\mini-experiments\tool-calling