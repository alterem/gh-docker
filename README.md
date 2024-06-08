# gh-docker
Use Cloudflare Workers to accelerate GitHub file downloads and Docker Hub image pulls.


### daemon
sudo tee /etc/docker/daemon.json <<EOF
{
    "registry-mirrors": ["https://your.domain"]
}
EOF


### cli
docker pull your.domain/library/nginx
