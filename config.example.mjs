"use strict";

const config = {
    homeserver:
        "https://matrix.example.com/" /* The full matrix homeserver, not just the delegated domain */,
    token: "..." /* The access token of the bot account */,
    prefix: "!" /* The command !prefix - bot will only respond to messages that are valid commands starting with it */,
    imag: "https://imag.example.com/" /* The Imag instance the bot should post to */,
    imag_key: "..." /* The Imag instance's access key */,
    autojoin: false /* Should the bot auto-join rooms its invited to? */,
    admin: "@admin:example.com" /* The administrator of the bot (can use commands such as !join */,
    room: "#quotes:example.com" /* The first room to join on bot startup, can be a room ID or alias */,
};

export default config;
