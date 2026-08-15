Validate and finish the asynchronous DMA sender. `platform_dma_start` retains the supplied buffer until `dma_send_complete` is called. Reject oversized or overlapping sends, preserve the frame bytes for the entire DMA ownership interval, and release ownership on start failure or completion.

When an engineering review completion gate is present, let it run automatically. Do not call `engineering_review` manually.
