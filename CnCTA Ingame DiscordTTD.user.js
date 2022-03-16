"use strict";
// ==UserScript==
// @version     2021.05.26
// @name        CnCTA Ingame Discord
// @include     http*://prodgame*.alliances.commandandconquer.com/*/index.aspx*
// @include     http*://cncapp*.alliances.commandandconquer.com/*/index.aspx*
// ==/UserScript==

const injectScript = () => {
   if (/commandandconquer\.com/i.test(document.domain)) {
       try {
           const script_block = document.createElement('script');
           script_block.type = 'text/javascript';
           script_block.async = true;
           script_block.defer = true;
           script_block.src = 'https://cdn.jsdelivr.net/npm/@widgetbot/crate@3';
           script_block.innerHTML = `
new Crate({
  server: '571297728215121930', // Through the Darkness
  channel: '946776060173885510' // #wrath29-chat
});`;
           document.getElementsByTagName('head')[0].appendChild(script_block);
       }
       catch (e) {
           console.log('Failed to inject script', e);
       }
   }
};

setTimeout(injectScript, 1000);
