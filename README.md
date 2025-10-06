# egrass-bot

A Discord bot to automate daily [NeetCode] challenges for my friends and I.

[NeetCode]: https://neetcode.io

## Features
- Automatically announces the problems for each day at midnight
- Tracks solves via "✅" reactions to the announcement message
    - Edits the announcement to display the user who solves the problems first
    - Display solve statistics for users
- Creates a thread for discussion about each problem
- Uses slash commands to modify/view the list of each day's problems

## Design
- Stores data in a persistent SQLite3 database
- Uses Discord's WebSocket API for efficient event-driven communication
- Containerized using Docker for easy deployment

## Screenshots

<p>
	<figure>
		<figcaption>Daily problem announcement</figcaption>
		<img width="600" src="./screenshots/announcement.png"></img>
	</figure>
</p>

<p>
<figure>
	<figcaption>Solve statistics</figcaption>
	<img width="300" src="./screenshots/stats.png"></img>
</figure>
</p>

## License & screenshots

Copyright (C) 2025 Kian Kasad ([@kdkasad]) <[kian@kasad.com]>

Licensed under the GNU GPL v3. See [COPYING](./COPYING) for details.

[@kdkasad]: https://github.com/kdkasad
[kian@kasad.com]: mailto:kian@kasad.com
