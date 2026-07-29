# pdrive


Also the top menu above the editor get's squished on mobile and you can't see all the buttons.

We also want to save the user provided url in local storage and allow them to select it on startup. (and save their password, optionally encrypted with a pin)

We also want to have the the python server serve the web page as well. 

So this will mostly be hosted on a local network, and clients will only connect on the local network. But we'd like to make a way for clients to enable offline mode for specific files. So there should be an option to do this, and then is should be shown visually somehow in the explorer view. Then for offline edits we want to do this:

- new files should just be uploaded
- for editing existing files
    + if the client has modified since (and the server has no changes) then update the file
    + if the client has modified and the server has changes, then prompt the user with the option to make a copy file with their changes, or just to except the server changes
    + if the client's hasn't changed but the server's has, just update the client's file

