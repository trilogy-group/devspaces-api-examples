# Overview

This repo has some example code showing how to connect to the gitpod api.
There are two main methods:

1. From outside a workspace, you connect via oauth. This requires you have the ability to listen on ports on the local host, as that is where the oauth will return
2. From inside a workspace, you connect via the supervisor-api, which runs on port 22999 inside every workspace.

# Supervisor API

In the subfolders supervisor-api

# OAuth

Not yet available. See the local-app inside the main gitpod repo for examples