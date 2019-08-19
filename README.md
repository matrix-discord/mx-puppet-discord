[Support Chat](https://matrix.to/#/#mx-puppet-bridge:sorunome.de) [![donate](https://liberapay.com/assets/widgets/donate.svg)](https://liberapay.com/Sorunome/donate)

# mx-puppet-discord
This is a discord puppeting bridge for matrix. It only handles DMs. For a discord bridge for guilds, please see [matrix-appservice-discord](https://github.com/Half-Shot/matrix-appservice-discord).
It is based on [mx-puppet-bridge](https://github.com/Sorunome/mx-puppet-bridge).

## Setup

Clone the repo and install the dependencies:

```
git clone https://github.com/matrix-discord/mx-puppet-discord
cd mx-puppet-discord
npm install
```

Copy and edit the configuration file to your liking:

```
cp sample.config.yaml config.yaml
... edit config.yaml ...
```

Generate an appservice registration file. Optional parameters are shown in
brackets with default values:

```
npm run start -- -r [-c config.yaml] [-f discord-registration.yaml]
```

Then add the path to the registration file to your synapse `homeserver.yaml`
under `app_service_config_files`.

Finally, run the bridge:

```
npm run start
```

## Usage

Start a chat with `@_discordpuppet_bot:yourserver.com`. When it joins, type
`help` in the chat to see instructions.

### Linking a Discord bot account

This is the recommended method, and allows Discord users to PM you through a
bot.

First visit your [Discord Application
Portal](https://discordapp.com/login?redirect_to=%2Fdevelopers%2Fapplications%2Fme).

1. Click on 'New Application'

![](img/bot-1.jpg)

2. Customize your bot how you like

![](img/bot-2.jpg)

3. Go to ‘**Create Application**’ and scroll down to the next page. Find ‘**Create a Bot User**’ and click on it.

![](img/bot-3.jpg)

4. Click '**Yes, do it!**

![](img/bot-4.jpg)

5. Find the bot's token in the '**App Bot User**' section.

![](img/bot-5.jpg)

6. Click '**Click to Reveal**'

![](img/bot-6.jpg)

Finally, send the appservice bot a message with the contents `link
your.token-here`.

### Linking your Discord account

**Warning**: Linking your user account's token is against Discord's Terms of Service.

First [retrieve your Discord User Token](https://discordhelp.net/discord-token).

Then send the bot a message with the contents `link your.token-here`.

