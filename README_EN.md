#  Claw in Chrome

<div align="center">

![Claw in Chrome](https://img.shields.io/badge/Claw-in%20Chrome-blue?style=for-the-badge)
![Version](https://img.shields.io/badge/version-1.0.66-green?style=for-the-badge)
![Platform](https://img.shields.io/badge/platform-Chrome%20116%2B-lightgrey?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-orange?style=for-the-badge)

</div>

[简体中文](./README.md) | English

"A Chrome sidebar assistant extension that lifts the login and plan restrictions of 'Claude in Chrome'. It features support for custom model providers and allows editing of previously restricted parameters, optimizing your LLM's performance within the plugin."

## Overview

Main features of this extension:

- Support for integrating your own model API.
- Let AI control your browser from the sidebar to complete tasks for you.


## 1. Install

1. Open `chrome://extensions/`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this `claw in chrome` folder
5. Pin `Claw` to the browser toolbar

## 2. Configure

Open the extension options page first, then go to `Model provider` on the left.

After creating a profile, mainly fill in these fields:


- `Provider format`
- `Base URL`
- `API Key`
- `Model`

After that, click `Save and apply`, then close and reopen the side panel. Once that is done, you are ready to use it. 
## 3. Recommended Settings

**It is  recommended to set the "Provider Format" to the `Anthropic` protocol.** Compared to other protocol formats, using the Anthropic protocol maximizes the tool's potential, resulting in better model performance and response quality in practical use.

![Provider settings](./docs/screenshots/05.png)

## Star History

<a href="https://www.star-history.com/?repos=S-Trespassing%2Fclaw-in-chrome&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=S-Trespassing/claw-in-chrome&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=S-Trespassing/claw-in-chrome&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=S-Trespassing/claw-in-chrome&type=date&legend=top-left" />
 </picture>
</a>