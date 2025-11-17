
document.addEventListener('DOMContentLoaded', () => {
    const cameraItems = document.querySelectorAll('.camera-item');
    for (let i = 0; i < cameraItems.length; i++) {
        let id = cameraItems[i].id
        document.getElementById(id).addEventListener('click', () => {
            fetch('/get-video', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ id }),
              })
                .then(response => {
                  if (!response.ok) throw new Error('Network response was not ok');
                  return response.blob(); // get video as a Blob
                })
                .then(videoBlob => {
                  const videoURL = URL.createObjectURL(videoBlob);
                  const videoPlayer = document.getElementById('videoPlayer');
                  videoPlayer.src = videoURL;
                })
                .catch(error => {
                  console.error('Error fetching video:', error);
                });
        });
    }
});
