/** Hand bytes to the browser as a file. The one place the editor touches the DOM for output. */
export const download = (name: string, bytes: Uint8Array | string, type: string): void => {
    const blob = new Blob([bytes as BlobPart], {type})
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
}
